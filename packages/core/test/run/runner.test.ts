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
import { createRunSnapshot } from "../../src/run/snapshot.ts";

describe("AgentRunner", () => {
  test("uses the prepared prompt/schema snapshot for every model step", async () => {
    const workspace = await createTempWorkspace();
    try {
      const provider = new FakeProvider([
        { response: toolResponse([toolCall("read-1", "read", { path: "missing.txt" })]) },
        { response: textResponse("done") },
      ]);
      const runner = new AgentRunner({
        environment: environmentWithLlm(),
        bus: createBus(),
        homeDirectory: workspace,
        providerFactory: () => provider,
      });
      const prepared = await runner.prepareSnapshot({
        workspaceRoot: workspace,
        notes: "snapshot note",
        files: { global: "global", project: "project" },
      });
      const snapshot = createRunSnapshot(
        prepared.systemPrompt,
        prepared.toolSchemas.map((tool) => ({
          ...tool,
          description: `${tool.description} (snapshot)`,
        })),
      );
      const outcome = await runner.run(
        {
          sessionId: SESSION_A,
          runId: RUN_A,
          goal: "inspect",
          workspaceRoot: workspace,
          systemPrompt: "stale legacy prompt",
          snapshot,
        },
        new AbortController().signal,
      );
      expect(outcome.completion.status).toBe("succeeded");
      expect(provider.calls).toHaveLength(2);
      for (const call of provider.calls) {
        expect(call.options?.system).toBe(snapshot.systemPrompt);
        expect(call.options?.toolSchemas).toBe(snapshot.toolSchemas);
      }
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

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

test("MCP preflight and execution share original schemas and approval lifecycle", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { McpServerManager } = await import("../../src/mcp/server-manager.ts");
  const { PermissionManager } = await import("../../src/permissions/manager.ts");
  const workspace = await createTempWorkspace();
  const schema = {
    type: "object" as const,
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  };
  let called = 0;
  const mcp = new McpServerManager(workspace, {}, () => ({
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: "search", inputSchema: schema }];
    },
    async callTool() {
      called++;
      return { content: [{ type: "text", text: "search result" }] };
    },
  }));
  try {
    await mkdir(join(workspace, ".minicode"));
    await writeFile(
      join(workspace, ".minicode/config.toml"),
      '[[mcp.servers]]\nname="demo"\ntransport="stdio"\ncommand="fixture"\n',
    );
    const bus = createBus();
    const permissions = new PermissionManager(bus);
    const { events, subscription } = await collectEvents(bus, SESSION_A, RUN_A);
    const provider = new FakeProvider([
      { response: toolResponse([toolCall("search", "mcp__demo__search", { query: "hello" })]) },
      { response: textResponse("done") },
    ]);
    const runner = new AgentRunner({
      environment: environmentWithLlm(),
      bus,
      permissions,
      permissionMode: "alwaysask",
      mcp,
      homeDirectory: workspace,
      providerFactory: () => provider,
    });
    const snapshot = await runner.prepareSnapshot({
      workspaceRoot: workspace,
      notes: "",
      files: { global: "", project: "" },
    });
    expect(snapshot.toolSchemas.find((t) => t.name === "mcp__demo__search")?.inputSchema).toEqual(
      schema,
    );
    const pending = runner.run(
      { sessionId: SESSION_A, runId: RUN_A, goal: "search", workspaceRoot: workspace, snapshot },
      new AbortController().signal,
    );
    for (let i = 0; i < 100 && !events.some((e) => e.type === "permission.requested"); i++)
      await Bun.sleep(1);
    const request = events.find((e) => e.type === "permission.requested");
    expect(request?.type).toBe("permission.requested");
    expect(called).toBe(0);
    if (request?.type === "permission.requested")
      await permissions.respond({
        sessionId: SESSION_A,
        runId: RUN_A,
        permissionRequestId: request.payload.permissionRequestId,
        decision: "allow_once",
      });
    expect((await pending).completion.status).toBe("succeeded");
    expect(called).toBe(1);
    expect(provider.calls).toHaveLength(2);
    for (const call of provider.calls) expect(call.options?.toolSchemas).toBe(snapshot.toolSchemas);
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain("search result");
    subscription.dispose();
  } finally {
    await mcp.close();
    await cleanupTempWorkspace(workspace);
  }
});
