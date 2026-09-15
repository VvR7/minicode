import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { LlmError } from "../../src/llm/errors.ts";
import { AgentRunner } from "../../src/run/runner.ts";
import { tasksPath } from "../../src/tasks/task-store.ts";
import { TraceService } from "../../src/trace/service.ts";
import { MemoryTraceStorage } from "../trace/test-helpers.ts";
import { MemoryTaskStorage } from "../tasks/test-helpers.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import {
  SESSION_A,
  SESSION_B,
  RUN_A,
  RUN_B,
  FakeProvider,
  collectEvents,
  createBus,
  textResponse,
  toolCall,
  toolResponse,
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
      const runner = new AgentRunner({
        environment: environmentWithoutLlm(),
        bus,
        homeDirectory: "/home",
      });
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
        homeDirectory: "/home",
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
        homeDirectory: "/home",
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
        homeDirectory: "/home",
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
        homeDirectory: "/home",
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
        homeDirectory: "/home",
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

  test("injects run-scoped task tools into the real AgentLoop and persists their event", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const storage = new MemoryTaskStorage();
      const provider = new FakeProvider([
        {
          response: toolResponse([
            toolCall("task-call", "task_create", {
              subject: "inspect",
              description: "inspect the workspace",
            }),
          ]),
        },
        { response: textResponse("done") },
      ]);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        homeDirectory: "/home",
        taskStorage: storage,
        providerFactory: () => provider,
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "plan", workspaceRoot: workspace },
        new AbortController().signal,
      );
      await subscription.closed;

      expect(finishedOf(events)).toMatchObject({ status: "succeeded", finalText: "done" });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.created",
          payload: expect.objectContaining({ revision: 1 }),
        }),
      );
      const persisted = storage.files.get(tasksPath("/home", SESSION_A, RUN_A));
      expect(JSON.parse(persisted ?? "null")).toMatchObject({
        revision: 1,
        nextId: 2,
        tasks: [expect.objectContaining({ id: 1, subject: "inspect" })],
      });
      expect(provider.calls[0]?.options?.toolSchemas?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["task_create", "task_update", "task_list", "task_get"]),
      );
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("keeps task managers, files and events isolated across concurrent runs", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const storage = new MemoryTaskStorage();
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        homeDirectory: "/home",
        taskStorage: storage,
        providerFactory: () =>
          new FakeProvider([
            {
              response: toolResponse([
                toolCall("task-call", "task_create", {
                  subject: "isolated",
                  description: "belongs to one run",
                }),
              ]),
            },
            { response: textResponse("done") },
          ]),
      });
      const first = await collectEvents(bus, SESSION_A, RUN_A);
      const second = await collectEvents(bus, SESSION_B, RUN_B);

      await Promise.all([
        runner.run(
          { sessionId: SESSION_A, runId: RUN_A, goal: "first", workspaceRoot: workspace },
          new AbortController().signal,
        ),
        runner.run(
          { sessionId: SESSION_B, runId: RUN_B, goal: "second", workspaceRoot: workspace },
          new AbortController().signal,
        ),
      ]);
      await Promise.all([first.subscription.closed, second.subscription.closed]);

      const firstPath = tasksPath("/home", SESSION_A, RUN_A);
      const secondPath = tasksPath("/home", SESSION_B, RUN_B);
      expect(firstPath).not.toBe(secondPath);
      expect(JSON.parse(storage.files.get(firstPath) ?? "null").revision).toBe(1);
      expect(JSON.parse(storage.files.get(secondPath) ?? "null").revision).toBe(1);
      expect(first.events.filter((event) => event.type === "task.created")).toHaveLength(1);
      expect(second.events.filter((event) => event.type === "task.created")).toHaveLength(1);
      expect(first.events.every((event) => event.runId === RUN_A)).toBe(true);
      expect(second.events.every((event) => event.runId === RUN_B)).toBe(true);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
