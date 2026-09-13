import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { AgentRunner } from "../../src/run/runner.ts";
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

  test("fails with run_timeout when the whole run exceeds its timeout", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        runTimeoutMs: 20,
        providerFactory: () => new HangProvider(),
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "failed", reason: "run_timeout" });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("cancels when the external signal aborts", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
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
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
