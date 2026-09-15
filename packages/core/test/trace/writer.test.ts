import { describe, expect, test } from "bun:test";
import { TraceRecordSchema } from "../../src/trace/types.ts";
import { TraceWriter } from "../../src/trace/writer.ts";
import { RUN_B, RUN_C, SESSION_A } from "../session/test-helpers.ts";
import { MemoryTraceStorage, makeTraceRecord } from "./test-helpers.ts";

const fullConfig = {
  enabled: true,
  payload: "full" as const,
  queueEvents: 100,
  maxBytes: 1_000_000,
  shutdownMs: 1000,
};

describe("TraceWriter", () => {
  test("writes records with continuous per-run sequences", async () => {
    const storage = new MemoryTraceStorage();
    const writer = new TraceWriter(SESSION_A, RUN_B, fullConfig, storage, "/run");
    writer.start();
    writer.enqueue(makeTraceRecord(0, {}, RUN_B));
    writer.enqueue(makeTraceRecord(1, {}, RUN_B));
    writer.enqueue(makeTraceRecord(2, {}, RUN_B));
    const report = await writer.stop();
    expect(report.recordsWritten).toBe(3);
    expect(report.bytesWritten).toBeGreaterThan(0);
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    for (const record of records) {
      expect(TraceRecordSchema.safeParse(record).success).toBe(true);
      expect(record.runId).toBe(RUN_B);
    }
  });

  test("drops on queue overflow and reports counts in a truncated record", async () => {
    const storage = new MemoryTraceStorage();
    let releaseOpen!: () => void;
    storage.openGate = new Promise((resolve) => {
      releaseOpen = resolve;
    });
    const writer = new TraceWriter(
      SESSION_A,
      RUN_B,
      { ...fullConfig, queueEvents: 16 },
      storage,
      "/run",
    );
    writer.start();
    // worker 阻塞在 openAppend，队列尚未消费，溢出数量是确定的。
    for (let index = 0; index < 40; index += 1) {
      writer.enqueue(makeTraceRecord(index, {}, RUN_B));
    }
    releaseOpen();
    const report = await writer.stop();
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    const truncated = records.find((record) => record.kind === "trace.truncated");
    expect(truncated).toBeDefined();
    expect(truncated.data.reason).toBe("queue_overflow");
    expect(truncated.data.droppedRecords).toBe(40 - 16);
    // 16 条普通记录 + 1 条 truncated。
    expect(report.recordsWritten).toBe(17);
    expect(report.droppedRecords).toBe(0);
  });

  test("stops writing at the size limit and records a truncated diagnostic", async () => {
    const storage = new MemoryTraceStorage();
    const writer = new TraceWriter(
      SESSION_A,
      RUN_B,
      { ...fullConfig, maxBytes: 3000 },
      storage,
      "/run",
    );
    writer.start();
    for (let index = 0; index < 30; index += 1) {
      writer.enqueue(makeTraceRecord(index, { payload: "some bytes".repeat(4) }, RUN_B));
    }
    const report = await writer.stop();
    expect(report.bytesWritten).toBeLessThanOrEqual(3000);
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    const truncated = records.find((record) => record.kind === "trace.truncated");
    expect(truncated).toBeDefined();
    expect(truncated.data.reason).toBe("size_limit");
    expect(report.droppedRecords).toBeGreaterThan(0);
  });

  test("reports serialization failures via truncated record and keeps writing", async () => {
    const storage = new MemoryTraceStorage();
    const writer = new TraceWriter(SESSION_A, RUN_B, fullConfig, storage, "/run");
    writer.start();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    writer.enqueue({
      schemaVersion: 1,
      observedAt: "2026-09-14T08:00:00.000Z",
      source: "CORE",
      target: "CORE",
      kind: "ipc.error",
      sessionId: SESSION_A,
      runId: RUN_B,
      data: circular as Record<string, unknown>,
    });
    writer.enqueue(makeTraceRecord(1, {}, RUN_B));
    const report = await writer.stop();
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    const truncated = records.find((record) => record.kind === "trace.truncated");
    expect(truncated).toBeDefined();
    expect(truncated.data.droppedRecords).toBe(1);
    // 循环引用记录被丢弃，正常记录照常写入且 sequence 连续。
    expect(records.some((record) => record.kind === "ipc.error" && record.sequence === 2)).toBe(
      true,
    );
    expect(report.recordsWritten).toBe(2);
    expect(report.droppedRecords).toBe(0);
  });

  test("swallows open and write failures and reports them", async () => {
    const openStorage = new MemoryTraceStorage();
    openStorage.openError = new Error("disk full");
    const openWriter = new TraceWriter(SESSION_A, RUN_B, fullConfig, openStorage, "/run");
    openWriter.start();
    openWriter.enqueue(makeTraceRecord(0, {}, RUN_B));
    const openReport = await openWriter.stop();
    expect(openReport.writeFailed).toBe(true);
    expect(openReport.recordsWritten).toBe(0);

    const writeStorage = new MemoryTraceStorage();
    writeStorage.writeError = new Error("disk full");
    const writeWriter = new TraceWriter(SESSION_A, RUN_B, fullConfig, writeStorage, "/run");
    writeWriter.start();
    writeWriter.enqueue(makeTraceRecord(0, {}, RUN_B));
    const writeReport = await writeWriter.stop();
    expect(writeReport.writeFailed).toBe(true);
  });

  test("start and stop are idempotent", async () => {
    const storage = new MemoryTraceStorage();
    const writer = new TraceWriter(SESSION_A, RUN_B, fullConfig, storage, "/run");
    writer.start();
    writer.start();
    writer.enqueue(makeTraceRecord(0, {}, RUN_B));
    const first = await writer.stop();
    const second = await writer.stop();
    expect(second).toEqual(first);
    // 停止后再 start 是 no-op，后续 enqueue 被丢弃。
    writer.start();
    writer.enqueue(makeTraceRecord(1, {}, RUN_B));
    const third = await writer.stop();
    expect(third.recordsWritten).toBe(first.recordsWritten);
  });

  test("reports unflushed records when shutdown exceeds the deadline", async () => {
    const storage = new MemoryTraceStorage();
    storage.writeDelayMs = 5;
    const writer = new TraceWriter(
      SESSION_A,
      RUN_B,
      { ...fullConfig, shutdownMs: 1 },
      storage,
      "/run",
    );
    writer.start();
    for (let index = 0; index < 50; index += 1) {
      writer.enqueue(makeTraceRecord(index, {}, RUN_B));
    }
    const report = await writer.stop();
    expect(report.timedOut).toBe(true);
    expect(report.pendingRecords).toBeGreaterThan(0);
  });

  test("returns within the deadline when open or write never settles", async () => {
    for (const blocked of ["open", "write"] as const) {
      const storage = new MemoryTraceStorage();
      const never = new Promise<void>(() => {});
      if (blocked === "open") storage.openGate = never;
      else storage.writeGate = never;
      const writer = new TraceWriter(
        SESSION_A,
        RUN_B,
        { ...fullConfig, shutdownMs: 20 },
        storage,
        "/run",
      );
      writer.start();
      writer.enqueue(makeTraceRecord(0, {}, RUN_B));
      const started = performance.now();
      const report = await writer.stop();
      expect(performance.now() - started).toBeLessThan(150);
      expect(report.timedOut).toBe(true);
    }
  });

  test("restores file bytes and sequence before appending", async () => {
    const storage = new MemoryTraceStorage();
    const path = "/run/trace.jsonl";
    const existing = { ...makeTraceRecord(0, {}, RUN_B), sequence: 1 };
    storage.files.set(path, `${JSON.stringify(existing)}\n`);
    const writer = new TraceWriter(SESSION_A, RUN_B, fullConfig, storage, "/run");
    writer.start();
    writer.enqueue(makeTraceRecord(1, {}, RUN_B));
    const report = await writer.stop();
    const records = storage.lines(path).map((line) => JSON.parse(line));
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(report.bytesWritten).toBe(
      new TextEncoder().encode(storage.files.get(path) ?? "").byteLength,
    );
  });

  test("keeps independent writers on their own sequences and files", async () => {
    const firstStorage = new MemoryTraceStorage();
    const secondStorage = new MemoryTraceStorage();
    const first = new TraceWriter(SESSION_A, RUN_B, fullConfig, firstStorage, "/sessions/a/runs/x");
    const second = new TraceWriter(
      SESSION_A,
      RUN_C,
      fullConfig,
      secondStorage,
      "/sessions/a/runs/y",
    );
    first.start();
    second.start();
    first.enqueue(makeTraceRecord(0, {}, RUN_B));
    first.enqueue(makeTraceRecord(1, {}, RUN_B));
    second.enqueue(makeTraceRecord(0, {}, RUN_C));
    await first.stop();
    await second.stop();
    const firstSeqs = firstStorage
      .lines("/sessions/a/runs/x/trace.jsonl")
      .map((line) => JSON.parse(line).sequence);
    const secondSeqs = secondStorage
      .lines("/sessions/a/runs/y/trace.jsonl")
      .map((line) => JSON.parse(line).sequence);
    expect(firstSeqs).toEqual([1, 2]);
    expect(secondSeqs).toEqual([1]);
  });
});
