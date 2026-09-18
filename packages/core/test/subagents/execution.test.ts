import { expect, test } from "bun:test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentRunner } from "../../src/run/runner.ts";
import { PermissionManager } from "../../src/permissions/manager.ts";
import { createSpawnAgentTool } from "../../src/subagents/spawn-tool.ts";
import { recoverSubagents } from "../../src/subagents/executor.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import {
  SESSION_A,
  RUN_A,
  SESSION_B,
  FakeProvider,
  collectEvents,
  createBus,
  textResponse,
  toolCall,
  toolResponse,
  type FakeTurn,
} from "../agent/test-helpers.ts";
import { environmentWithLlm } from "../run/test-helpers.ts";
/** 建立父子共用工作区、独立 provider 和可选类型配置。 */
async function fixture(
  childTurns: readonly FakeTurn[],
  profile?: string,
  environmentOverrides: Record<string, string> = {},
) {
  const workspace = await createTempWorkspace();
  await mkdir(join(workspace, ".minicode/agents"), { recursive: true });
  if (profile) await writeFile(join(workspace, ".minicode/agents/custom.toml"), profile);
  const bus = createBus();
  const permissions = new PermissionManager(bus);
  const parent = new FakeProvider([
    {
      response: toolResponse([
        toolCall("spawn", "spawn_agent", {
          name: profile ? "custom" : "executor",
          goal: "child goal",
          context: "explicit context",
        }),
      ]),
    },
    { response: textResponse("parent done") },
  ]);
  const child = new FakeProvider(childTurns);
  let count = 0;
  const runner = new AgentRunner({
    environment: environmentWithLlm(environmentOverrides),
    bus,
    permissions,
    homeDirectory: workspace,
    providerFactory: () => (count++ === 0 ? parent : child),
  });
  const observed = await collectEvents(bus, SESSION_A, RUN_A);
  const foreign = await collectEvents(bus, SESSION_B, RUN_A);
  const snapshot = await runner.prepareSnapshot({
    workspaceRoot: workspace,
    notes: "PARENT_PRIVATE_NOTES",
    files: { global: "fixed global rule", project: "fixed project rule" },
  });
  const run = (signal = new AbortController().signal) =>
    runner.run(
      {
        sessionId: SESSION_A,
        runId: RUN_A,
        workspaceRoot: workspace,
        goal: "parent goal",
        history: [{ role: "user", content: [{ type: "text", text: "PARENT_PRIVATE_HISTORY" }] }],
        snapshot,
      },
      signal,
    );
  const childDirectory = async () => {
    const root = join(workspace, "sessions", SESSION_A, "runs", RUN_A, "subagents");
    const names = await readdir(root);
    const name = names[0];
    if (!name) throw new Error("missing child directory");
    return { directory: join(root, name), childRunId: name };
  };
  return {
    workspace,
    parent,
    child,
    bus,
    permissions,
    runner,
    observed,
    foreign,
    snapshot,
    run,
    childDirectory,
    async cleanup() {
      observed.subscription.dispose();
      foreign.subscription.dispose();
      permissions.close();
      await cleanupTempWorkspace(workspace);
    },
  };
}

test("sync delegation isolates parent history/tasks/notes, inherits fixed rules and skill catalog", async () => {
  const f = await fixture(
    [
      {
        response: toolResponse([
          toolCall("task", "task_create", {
            subject: "child private task",
            description: "private",
          }),
          toolCall("note", "note_save", { content: "child private note" }),
        ]),
      },
      { response: textResponse("child result") },
    ],
    '[agent]\ndescription="custom"\nsystem_prompt="child role"\nallowed_tools=["task_create","note_save"]\n',
  );
  try {
    const outcome = await f.run();
    expect(outcome.completion.status).toBe("succeeded");
    expect(outcome.completion.taskGraph).toBeUndefined();
    expect(JSON.stringify(f.parent.calls[1]?.messages)).toContain("child result");
    expect(JSON.stringify(f.child.calls)).not.toContain("PARENT_PRIVATE_HISTORY");
    expect(JSON.stringify(f.child.calls)).not.toContain("PARENT_PRIVATE_NOTES");
    expect(f.child.calls[0]?.options?.system).toContain("child role");
    expect(f.child.calls[0]?.options?.system).toContain("fixed global rule");
    expect(f.child.calls[0]?.options?.system).toContain("fixed project rule");
    expect(f.child.calls[0]?.options?.system).toContain("available skills");
    expect(JSON.stringify(f.child.calls[0]?.messages)).toContain("explicit context");
    expect(f.child.calls[0]?.options?.toolSchemas?.map((t) => t.name)).toEqual([
      "task_create",
      "note_save",
    ]);
    const { directory, childRunId } = await f.childDirectory();
    expect(await readFile(join(directory, "tasks.json"), "utf8")).toContain("child private task");
    expect(await readFile(join(directory, "notes.md"), "utf8")).toContain("child private note");
    expect(await Bun.file(join(f.workspace, "sessions", SESSION_A, "notes.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(f.workspace, "sessions", SESSION_A, "runs", childRunId)).exists(),
    ).toBe(false);
    expect(await readFile(join(directory, "history.json"), "utf8")).toContain("child result");
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).status).toBe(
      "succeeded",
    );
    const journal = await new EventStore(f.workspace, undefined, RUN_A).read(SESSION_A, childRunId);
    expect(journal.ok && journal.value.finished).toBe(true);
    expect(f.observed.events.filter((e) => e.type === "subagent.started")).toHaveLength(1);
    expect(f.observed.events.filter((e) => e.type === "subagent.finished")).toHaveLength(1);
    expect(f.observed.events.some((e) => e.type.startsWith("task."))).toBe(false);
    expect(f.foreign.events).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test.each(["unknown_tool", "spawn_agent", "list_subagent", "agent_result"])(
  "invalid whitelist rejects before child provider (%s)",
  async (name) => {
    const f = await fixture(
      [{ response: textResponse("never") }],
      `[agent]\ndescription="bad"\nsystem_prompt="bad"\nallowed_tools=["${name}"]\n`,
    );
    try {
      expect((await f.run()).completion.status).toBe("succeeded");
      expect(f.child.calls).toHaveLength(0);
      expect(f.observed.events.find((e) => e.type === "tool.finished")?.payload).toMatchObject({
        errorCode: "invalid_params",
      });
      expect(f.observed.events.some((e) => e.type === "subagent.started")).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

test("spawn revalidates latest profile, unknown profile becomes observation", async () => {
  const f = await fixture(
    [{ response: textResponse("never") }],
    '[agent]\ndescription="old"\nsystem_prompt="old"\nallowed_tools=[]\n',
  );
  try {
    await writeFile(join(f.workspace, ".minicode/agents/custom.toml"), "invalid=[]");
    await f.run();
    expect(f.child.calls).toHaveLength(0);
    expect(JSON.stringify(f.parent.calls[1]?.messages)).toContain("unknown or invalid subagent");
  } finally {
    await f.cleanup();
  }
});

test("child approval uses parent channel and identity; parent always cache is shared", async () => {
  const f = await fixture(
    [
      {
        response: toolResponse([
          toolCall("write", "write", { path: "child.txt", content: "child" }),
        ]),
      },
      { response: textResponse("done") },
    ],
    '[agent]\ndescription="writer"\nsystem_prompt="writer"\nallowed_tools=["write"]\n',
  );
  try {
    const pending = f.run();
    for (
      let i = 0;
      i < 100 && !f.observed.events.some((e) => e.type === "permission.requested");
      i++
    )
      await Bun.sleep(1);
    const request = f.observed.events.find((e) => e.type === "permission.requested");
    expect(request?.type).toBe("permission.requested");
    if (request?.type !== "permission.requested") throw new Error("missing approval");
    const { childRunId } = await f.childDirectory();
    expect(request.runId).toBe(RUN_A);
    expect(request.payload.childRunId).toBe(childRunId);
    expect(request.payload.toolCallId).toBe(`${childRunId}:write`);
    await f.permissions.respond({
      sessionId: SESSION_A,
      runId: RUN_A,
      permissionRequestId: request.payload.permissionRequestId,
      decision: "always_allow",
    });
    expect((await pending).completion.status).toBe("succeeded");
    expect(await readFile(join(f.workspace, "child.txt"), "utf8")).toBe("child");
    expect(
      await f.permissions.check(
        "write",
        { path: "another", content: "x" },
        { sessionId: SESSION_A, runId: RUN_A, toolCallId: "parent" },
        new AbortController().signal,
      ),
    ).toEqual({ allowed: true, source: "session_cache" });
    expect(f.observed.events.find((e) => e.type === "permission.resolved")?.payload).toMatchObject({
      childRunId,
    });
  } finally {
    await f.cleanup();
  }
});

test("parent abort drains child approval and audit before returning", async () => {
  const f = await fixture(
    [
      {
        response: toolResponse([
          toolCall("write", "write", { path: "never.txt", content: "never" }),
        ]),
      },
    ],
    '[agent]\ndescription="writer"\nsystem_prompt="writer"\nallowed_tools=["write"]\n',
  );
  try {
    const controller = new AbortController();
    const pending = f.run(controller.signal);
    for (let i = 0; i < 100 && f.permissions.pendingCount === 0; i++) await Bun.sleep(1);
    expect(f.permissions.pendingCount).toBe(1);
    controller.abort();
    expect((await pending).completion.status).toBe("cancelled");
    expect(f.permissions.pendingCount).toBe(0);
    expect(await Bun.file(join(f.workspace, "never.txt")).exists()).toBe(false);
    const { directory } = await f.childDirectory();
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).status).toBe(
      "cancelled",
    );
    expect(f.observed.events.find((e) => e.type === "subagent.finished")?.payload).toMatchObject({
      status: "cancelled",
    });
  } finally {
    await f.cleanup();
  }
});

test("synchronous tool bypasses default timeout and crash leftovers are interrupted", async () => {
  expect(
    createSpawnAgentTool(async () => ({ content: "done" })).timeoutMs?.({
      name: "planner",
      goal: "x",
    }),
  ).toBeNull();
  const f = await fixture([]);
  try {
    const id = crypto.randomUUID();
    const directory = join(f.workspace, "sessions", SESSION_A, "runs", RUN_A, "subagents", id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({ childRunId: id, name: "planner", status: "running" }),
    );
    await f.runner.recoverSubagents(SESSION_A, RUN_A);
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).status).toBe(
      "interrupted",
    );
    await recoverSubagents(f.workspace, SESSION_A, RUN_A);
    expect(f.child.calls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("child auto compaction checkpoint remains private and complete history survives", async () => {
  const f = await fixture(
    [
      {
        response: {
          ...toolResponse([toolCall("read", "read", { path: "large.txt" })]),
          usage: {
            inputTokens: 99500,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      },
      { response: textResponse("CHILD_PRIVATE_SUMMARY") },
      { response: textResponse("child done") },
    ],
    '[agent]\ndescription="reader"\nsystem_prompt="reader"\nallowed_tools=["read"]\n',
    { MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "100", MINICODE_COMPACTION_RESERVE_TOKENS: "5000" },
  );
  try {
    await writeFile(join(f.workspace, "large.txt"), "large private line\n".repeat(500));
    expect((await f.run()).completion.status).toBe("succeeded");
    const { directory } = await f.childDirectory();
    expect(await readFile(join(directory, "compaction.json"), "utf8")).toContain(
      "CHILD_PRIVATE_SUMMARY",
    );
    expect(await readFile(join(directory, "history.json"), "utf8")).toContain("large private line");
    expect(JSON.stringify(f.parent.calls)).not.toContain("CHILD_PRIVATE_SUMMARY");
    expect(f.observed.events.some((e) => e.type.startsWith("context.compaction"))).toBe(false);
    expect(
      await Bun.file(
        join(f.workspace, "sessions", SESSION_A, "runs", RUN_A, "compaction.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("child stops at twenty model steps and returns a failure observation", async () => {
  const f = await fixture(
    Array.from({ length: 20 }, (_, i) => ({
      response: toolResponse([toolCall(`read-${i}`, "read", { path: "missing" })]),
    })),
  );
  try {
    await f.run();
    expect(f.child.calls).toHaveLength(20);
    const { directory } = await f.childDirectory();
    expect(JSON.parse(await readFile(join(directory, "history.json"), "utf8"))).toMatchObject({
      status: "failed",
      reason: "max_steps",
      steps: 20,
    });
    expect(f.observed.events.find((e) => e.type === "subagent.finished")?.payload).toMatchObject({
      status: "failed",
    });
  } finally {
    await f.cleanup();
  }
});
