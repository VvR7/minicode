import { describe, expect, test } from "bun:test";
import { AgentRunner, runToolSchemas } from "../../src/run/runner.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import {
  SESSION_A,
  RUN_A,
  FakeProvider,
  collectEvents,
  createBus,
  textResponse,
  toolCall,
  toolResponse,
} from "../agent/test-helpers.ts";
import { HangProvider, environmentWithLlm, environmentWithoutLlm } from "./test-helpers.ts";

describe("AgentRunner", () => {
  test("fails with config_error and keeps the daemon alive when LLM config is missing", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithoutLlm(),
        bus,
        homeDirectory: workspace,
      });
      const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      // 不抛异常：Runner 把缺配置收敛为 config_error completion。
      const outcome = await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      subscription.dispose();

      expect(outcome.completion).toMatchObject({
        status: "failed",
        reason: "config_error",
        error: { code: "config_error", message: "run failed (config_error)" },
      });
      expect(events[0]?.type).toBe("run.started");
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("honors cancellation before reporting an invalid LLM configuration", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithoutLlm(),
        bus,
        homeDirectory: workspace,
      });
      const controller = new AbortController();
      controller.abort();

      const outcome = await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        controller.signal,
      );

      expect(outcome.completion).toMatchObject({ status: "cancelled", reason: "cancelled" });
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
        homeDirectory: workspace,
        providerFactory: () => provider,
      });
      const { subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      const outcome = await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      subscription.dispose();

      expect(outcome.completion).toMatchObject({ status: "succeeded", finalText: "hi" });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("composes task/note tools and returns the final task graph in RunCompletion", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const provider = new FakeProvider([
        {
          response: toolResponse([
            toolCall("task-1", "task_create", {
              subject: "Inspect",
              description: "Inspect the workspace",
            }),
            toolCall("note-1", "note_save", { content: "Remember the result" }),
          ]),
        },
        { response: textResponse("done") },
      ]);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        homeDirectory: workspace,
        providerFactory: () => provider,
      });

      const outcome = await runner.run(
        {
          sessionId: SESSION_A,
          runId: RUN_A,
          goal: "work",
          workspaceRoot: workspace,
          history: [{ role: "user", content: [{ type: "text", text: "old context" }] }],
        },
        new AbortController().signal,
      );

      expect(provider.calls[0]?.messages[0]?.content[0]).toEqual({
        type: "text",
        text: "old context",
      });
      expect(outcome.completion.messages[0]?.content[0]).toEqual({ type: "text", text: "work" });
      expect(
        outcome.completion.messages.some((message) =>
          message.content.some((part) => part.type === "text" && part.text === "old context"),
        ),
      ).toBe(false);
      expect(outcome.completion.taskGraph).toMatchObject({
        revision: 1,
        tasks: [{ id: 1, subject: "Inspect", status: "pending" }],
      });
      expect(runToolSchemas().map((schema) => schema.name)).toEqual(
        expect.arrayContaining([
          "read",
          "write",
          "edit",
          "bash",
          "task_create",
          "task_update",
          "task_list",
          "task_get",
          "note_save",
        ]),
      );
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("returns an internal_error completion when composition fails", async () => {
    const workspace = await createTempWorkspace();
    try {
      const bus = createBus();
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus,
        homeDirectory: workspace,
        providerFactory: () => {
          throw new Error("factory failed");
        },
      });
      const { subscription } = await collectEvents(bus, SESSION_A, RUN_A);
      const outcome = await runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        new AbortController().signal,
      );
      subscription.dispose();
      expect(outcome.completion).toMatchObject({ status: "failed", reason: "internal_error" });
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
        homeDirectory: workspace,
        providerFactory: () => new HangProvider(),
      });
      const { subscription } = await collectEvents(bus, SESSION_A, RUN_A);

      const controller = new AbortController();
      const running = runner.run(
        { sessionId: SESSION_A, runId: RUN_A, goal: "x", workspaceRoot: workspace },
        controller.signal,
      );
      controller.abort();
      const outcome = await running;
      subscription.dispose();

      expect(outcome.completion).toMatchObject({ status: "cancelled", reason: "cancelled" });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
