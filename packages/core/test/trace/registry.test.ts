import { describe, expect, test } from "bun:test";
import type { Environment } from "@minicode/protocol";
import { RunTraceRegistry } from "../../src/trace/registry.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { MemoryTraceStorage } from "./test-helpers.ts";

const ENVIRONMENT: Environment = {
  MINICODE_TRACE_ENABLED: "true",
  MINICODE_TRACE_PAYLOAD: "summary",
  MINICODE_TRACE_SHUTDOWN_MS: "100",
};

describe("RunTraceRegistry", () => {
  test("keeps the recorder alive until both run and initial response finish", async () => {
    const storage = new MemoryTraceStorage();
    const registry = new RunTraceRegistry("/home", ENVIRONMENT, storage);
    const recorder = registry.create(SESSION_A, RUN_A);
    recorder.record({ source: "CLIENT", target: "CORE", kind: "ipc.request_received" });

    expect(await registry.finishRun(SESSION_A, RUN_A)).toBeUndefined();
    expect(registry.get(SESSION_A, RUN_A)).toBe(recorder);

    recorder.record({ source: "CORE", target: "CLIENT", kind: "ipc.response_sent" });
    const report = await registry.finishResponse(SESSION_A, RUN_A);

    const tracePath = `/home/sessions/${SESSION_A}/runs/${RUN_A}/trace.jsonl`;
    expect(report?.recordsWritten).toBe(2);
    expect(registry.get(SESSION_A, RUN_A)).toBeUndefined();
    expect(storage.lines(tracePath)).toHaveLength(2);
    expect([...storage.files.keys()]).toEqual([tracePath]);
  });
});
