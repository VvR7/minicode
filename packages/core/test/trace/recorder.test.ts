import { describe, expect, test } from "bun:test";
import { TraceRecorder } from "../../src/trace/recorder.ts";
import { TraceRecordSchema } from "../../src/trace/types.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { MemoryTraceStorage } from "./test-helpers.ts";

const now = (): string => "2026-09-14T08:00:00.000Z";

function makeRecorder(
  storage: MemoryTraceStorage,
  payload: "summary" | "full",
  enabled = true,
): TraceRecorder {
  return new TraceRecorder(
    SESSION_A,
    RUN_A,
    { enabled, payload, queueEvents: 100, maxBytes: 1_000_000, shutdownMs: 1000 },
    storage,
    "/run",
    now,
  );
}

describe("TraceRecorder", () => {
  test("summary mode strips content and credentials but keeps structure and usage", async () => {
    const storage = new MemoryTraceStorage();
    const recorder = makeRecorder(storage, "summary");
    recorder.start();
    recorder.record({
      source: "LLM",
      target: "CORE",
      kind: "llm.request",
      step: 0,
      data: {
        model: "test-model",
        systemPrompt: "TOP SECRET PROMPT",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        apiKey: "sk-secret-123",
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });
    await recorder.stop();
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    const record = records[0];
    const raw = JSON.stringify(record);
    expect(raw).not.toContain("TOP SECRET PROMPT");
    expect(raw).not.toContain("hello");
    expect(raw).not.toContain("sk-secret-123");
    expect(record.sequence).toBe(1);
    expect(record.observedAt).toBe(now());
    expect(record.step).toBe(0);
    expect(record.data.model).toBe("test-model");
    expect(record.data.systemPrompt).toBe("[summarized]");
    expect(record.data.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(TraceRecordSchema.safeParse(record).success).toBe(true);
  });

  test("full mode keeps business payload but redacts credentials", async () => {
    const storage = new MemoryTraceStorage();
    const recorder = makeRecorder(storage, "full");
    recorder.start();
    recorder.record({
      source: "LLM",
      target: "CORE",
      kind: "llm.response",
      data: {
        prompt: "hello world",
        apiKey: "sk-secret",
        nested: { authorization: "Bearer abcdef123456" },
      },
    });
    await recorder.stop();
    const record = JSON.parse(storage.lines("/run/trace.jsonl")[0] as string);
    expect(record.data.prompt).toBe("hello world");
    expect(record.data.apiKey).toBe("[REDACTED]");
    expect(record.data.nested.authorization).toBe("[REDACTED]");
    const raw = JSON.stringify(record);
    expect(raw).toContain("hello world");
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("abcdef123456");
  });

  test("disabled recorder writes nothing", async () => {
    const storage = new MemoryTraceStorage();
    const recorder = makeRecorder(storage, "full", false);
    recorder.start();
    recorder.record({ source: "CORE", target: "CORE", kind: "ipc.error", data: { a: 1 } });
    await recorder.stop();
    expect(storage.lines("/run/trace.jsonl")).toHaveLength(0);
  });

  test("never throws on circular or unprocessable data", () => {
    const storage = new MemoryTraceStorage();
    const recorder = makeRecorder(storage, "full");
    recorder.start();
    const circular: { a: number; self?: unknown } = { a: 1 };
    circular.self = circular;
    expect(() =>
      recorder.record({ source: "CORE", target: "CORE", kind: "ipc.error", data: circular }),
    ).not.toThrow();
    expect(() =>
      recorder.record({ source: "CORE", target: "CORE", kind: "ipc.error" }),
    ).not.toThrow();
  });

  test("records a complete ipc/core/llm timeline with paired terminal records", async () => {
    const storage = new MemoryTraceStorage();
    const recorder = makeRecorder(storage, "full");
    recorder.start();
    recorder.record({
      source: "CLIENT",
      target: "CORE",
      kind: "ipc.request_received",
      connectionId: "conn-1",
      requestId: "req-1",
    });
    recorder.record({
      source: "CORE",
      target: "CLIENT",
      kind: "ipc.response_queued",
      connectionId: "conn-1",
      requestId: "req-1",
    });
    recorder.record({
      source: "CORE",
      target: "CLIENT",
      kind: "ipc.response_sent",
      connectionId: "conn-1",
      requestId: "req-1",
    });
    recorder.record({
      source: "CORE",
      target: "CORE",
      kind: "core.event_persisted",
      data: { event: "run.started" },
    });
    recorder.record({ source: "CORE", target: "LLM", kind: "llm.request", step: 0 });
    recorder.record({ source: "LLM", target: "CORE", kind: "llm.stream_delta", step: 0 });
    recorder.record({ source: "LLM", target: "CORE", kind: "llm.response", step: 0 });
    // 第二个 llm.request 以 cancelled 配对终结。
    recorder.record({ source: "CORE", target: "LLM", kind: "llm.request", step: 1 });
    recorder.record({ source: "CORE", target: "LLM", kind: "llm.cancelled", step: 1 });
    await recorder.stop();
    const records = storage.lines("/run/trace.jsonl").map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual([
      "ipc.request_received",
      "ipc.response_queued",
      "ipc.response_sent",
      "core.event_persisted",
      "llm.request",
      "llm.stream_delta",
      "llm.response",
      "llm.request",
      "llm.cancelled",
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
