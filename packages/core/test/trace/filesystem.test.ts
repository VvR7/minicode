import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeTraceStorage } from "../../src/trace/storage.ts";
import { TraceWriter } from "../../src/trace/writer.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { makeTraceRecord } from "./test-helpers.ts";

describe("trace filesystem behavior", () => {
  test("writes only under the run directory with private permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-trace-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-trace-ws-"));
    const runDirectory = join(home, "sessions", SESSION_A, "runs", RUN_A);
    const tracePath = join(runDirectory, "trace.jsonl");
    try {
      const writer = new TraceWriter(
        SESSION_A,
        RUN_A,
        { enabled: true, payload: "full", queueEvents: 100, maxBytes: 1_000_000, shutdownMs: 1000 },
        nodeTraceStorage,
        runDirectory,
      );
      writer.start();
      writer.enqueue(makeTraceRecord(0));
      writer.enqueue(makeTraceRecord(1));
      const report = await writer.stop();
      expect(report.recordsWritten).toBe(2);
      expect(report.writeFailed).toBe(false);

      const fileStat = await stat(tracePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const directoryStat = await stat(runDirectory);
      expect(directoryStat.mode & 0o777).toBe(0o700);

      // cwd 与 workspace 都不得出现 Trace 文件。
      expect(await stat(join(workspace, "trace.jsonl")).catch(() => undefined)).toBeUndefined();
      expect(await stat(join(process.cwd(), "trace.jsonl")).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
