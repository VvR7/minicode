import { describe, expect, test } from "bun:test";
import { TraceService, type TraceDiagnostic } from "../../src/trace/service.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { MemoryTraceStorage } from "./test-helpers.ts";

const config = {
  enabled: true,
  payload: "summary" as const,
  queueEvents: 100,
  maxBytes: 1_000_000,
  shutdownMs: 20,
};

describe("TraceService", () => {
  test("keeps a recorder alive until both run and initial response finish", async () => {
    const storage = new MemoryTraceStorage();
    const service = new TraceService("/home", config, storage);
    const recorder = service.startRun(SESSION_A, RUN_A, true);
    recorder?.record({ source: "CLIENT", target: "CORE", kind: "ipc.request_received" });

    expect(await service.finishRun(SESSION_A, RUN_A)).toBeUndefined();
    expect(service.recorderFor(SESSION_A, RUN_A)).toBe(recorder);
    recorder?.record({ source: "CORE", target: "CLIENT", kind: "ipc.response_sent" });
    const report = await service.finishResponse(SESSION_A, RUN_A);

    expect(report?.recordsWritten).toBe(2);
    expect(service.recorderFor(SESSION_A, RUN_A)).toBeUndefined();
  });

  test("publishes incomplete shutdown reports to the diagnostic outlet", async () => {
    const storage = new MemoryTraceStorage();
    storage.writeGate = new Promise<void>(() => {});
    const diagnostics: TraceDiagnostic[] = [];
    const service = new TraceService("/home", config, storage, (value) => diagnostics.push(value));
    const recorder = service.startRun(SESSION_A, RUN_A);
    recorder?.record({ source: "CORE", target: "CORE", kind: "ipc.error" });

    const report = await service.finishRun(SESSION_A, RUN_A);
    expect(report?.timedOut).toBe(true);
    expect(report?.pendingRecords).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.sessionId).toBe(SESSION_A);
  });
});
