import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { LlmError } from "../../src/llm/errors.ts";
import { AgentRunner } from "../../src/run/runner.ts";
import { TraceService } from "../../src/trace/service.ts";
import { MemoryTraceStorage } from "../trace/test-helpers.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import {
  SESSION_A,
  RUN_A,
  FakeProvider,
  collectEvents,
  createBus,
  textResponse,
} from "../agent/test-helpers.ts";
import { HangProvider, environmentWithLlm, environmentWithoutLlm } from "./test-helpers.ts";

function finishedOf(events: readonly AgentEvent[]) {
  const finished = events.find((e) => e.type === "run.finished");
  if (finished === undefined || finished.type !== "run.finished") {
    throw new Error("missing run.finished");
  }
  return finished.payload;
}

const traceConfig = {
  enabled: true,
  payload: "summary" as const,
  queueEvents: 100,
  maxBytes: 1_000_000,
  shutdownMs: 100,
};

/** 读取测试 run 已完成刷盘的 Trace kind。 */
function traceKinds(storage: MemoryTraceStorage): string[] {
  const path = `/home/sessions/${SESSION_A}/runs/${RUN_A}/trace.jsonl`;
  return storage.lines(path).map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe("AgentRunner", () => {
  test("fails with config_error and keeps the daemon alive when LLM config is missing", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({ environment: environmentWithoutLlm(), bus });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      // 不抛异常：run 把缺配置收敛为 run.finished(config_error)。
      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "failed", reason: "config_error" });
      expect(events[0]?.type).toBe("run.started");
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("runs to completion with an injected provider", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const provider = new FakeProvider([{ deltas: ["hi"], response: textResponse("hi") }]);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        providerFactory: () => provider,
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "succeeded", finalText: "hi" });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("publishes an internal_error terminal event when composition fails", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        providerFactory: () => {
          throw new Error("factory failed");
        },
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);
      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;
      expect(finishedOf(events)).toMatchObject({ status: "failed", reason: "internal_error" });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("pairs a provider error trace with its LLM request", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const storage = new MemoryTraceStorage();
      const traces = new TraceService("/home", traceConfig, storage);
      traces.startRun(SESSION_A, RUN_A);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        traceService: traces,
        providerFactory: () =>
          new FakeProvider([{ error: new LlmError("network_error", "secret") }]),
      });
      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      expect(traceKinds(storage)).toEqual(expect.arrayContaining(["llm.request", "llm.error"]));
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("fails with run_timeout when the whole run exceeds its timeout", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const storage = new MemoryTraceStorage();
      const traces = new TraceService("/home", traceConfig, storage);
      traces.startRun(SESSION_A, RUN_A);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        runTimeoutMs: 20,
        traceService: traces,
        providerFactory: () => new HangProvider(),
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "failed", reason: "run_timeout" });
      expect(traceKinds(storage)).toEqual(expect.arrayContaining(["llm.request", "llm.cancelled"]));
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("cancels when the external signal aborts", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const storage = new MemoryTraceStorage();
      const traces = new TraceService("/home", traceConfig, storage);
      traces.startRun(SESSION_A, RUN_A);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        traceService: traces,
        providerFactory: () => new HangProvider(),
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      const controller = new AbortController();
      const running = runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        controller.signal,
      );
      controller.abort();
      await running;
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "cancelled", reason: "cancelled" });
      expect(traceKinds(storage)).toEqual(expect.arrayContaining(["llm.request", "llm.cancelled"]));
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
