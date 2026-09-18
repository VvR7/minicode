import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApp, EventStore } from "../../packages/core/src/index.ts";
import { SessionStore } from "../../packages/core/src/session/session-store.ts";
import { SessionController, type SessionControllerEvent } from "../../packages/client/src/index.ts";
import { startScriptedAnthropicMock } from "./helpers/scripted-anthropic-mock.ts";
/** 等待真实 IPC 条件，不通过长时延猜测调度。 */
async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("subagent IPC timed out");
    await Bun.sleep(5);
  }
}

test.each([false, true])(
  "real Core routes child approval, isolates its turn, and reaps shutdown (%s)",
  async (shutdown) => {
    const root = await mkdtemp(join(tmpdir(), "minicode-child-core-"));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".minicode/agents"), { recursive: true });
    await Bun.write(
      join(workspace, ".minicode/agents/writer.toml"),
      '[agent]\ndescription="writer"\nsystem_prompt="PRIVATE_CHILD_ROLE"\nallowed_tools=["write","task_create"]\n',
    );
    const mock = startScriptedAnthropicMock((body) => {
      const data = body as { system: string; messages: { content: { type: string }[] }[] };
      const child = data.system.includes("PRIVATE_CHILD_ROLE");
      const completedTools = data.messages
        .at(-1)
        ?.content.some((part) => part.type === "tool_result");
      if (completedTools)
        return { kind: "text", chunks: [child ? "private child result" : "parent final"] };
      return child
        ? {
            kind: "tools",
            calls: [
              {
                id: "task",
                name: "task_create",
                input: { subject: "private child task", description: "private" },
              },
              {
                id: "write",
                name: "write",
                input: { path: "child.txt", content: "child content" },
              },
            ],
          }
        : {
            kind: "tools",
            calls: [
              { id: "spawn", name: "spawn_agent", input: { name: "writer", goal: "write child" } },
            ],
          };
    });
    const homeDirectory = join(root, "home");
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory },
      {
        LLM_API_KEY: "fixture",
        LLM_BASE_URL: mock.url,
        LLM_MODEL: "fixture",
        LLM_CONTEXT_WINDOW_TOKENS: "100000",
        LLM_MAX_OUTPUT_TOKENS: "4096",
        MINICODE_TRACE_ENABLED: "false",
      },
    );
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      endpoint: app.start(),
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      const session = await controller.create(workspace);
      const run = await controller.sendMessage("delegate");
      await waitFor(() => controller.permissions.length === 1);
      const approval = controller.permissions[0]?.request;
      if (!approval) throw new Error("missing child approval");
      expect(approval.runId).toBe(run.runId);
      const childRunId = approval.payload.childRunId;
      if (!childRunId) throw new Error("missing child identity");
      const childDirectory = join(
        homeDirectory,
        "sessions",
        session.sessionId,
        "runs",
        run.runId,
        "subagents",
        childRunId,
      );
      if (shutdown) {
        await app.stop();
        expect(await Bun.file(join(workspace, "child.txt")).exists()).toBe(false);
      } else {
        await controller.respondPermission(
          run.runId,
          approval.payload.permissionRequestId,
          "allow_once",
        );
        await waitFor(() =>
          events.some((e) => e.type === "turn.committed" && e.runId === run.runId),
        );
        expect(await readFile(join(workspace, "child.txt"), "utf8")).toBe("child content");
      }
      const state = JSON.parse(await readFile(join(childDirectory, "state.json"), "utf8"));
      expect(state.status).toBe(shutdown ? "cancelled" : "succeeded");
      const loaded = await new SessionStore(homeDirectory).load(session.sessionId);
      expect(loaded.ok && loaded.value.turns).toHaveLength(1);
      expect(loaded.ok && loaded.value.turns[0]?.taskGraph).toBeUndefined();
      const parent = await new EventStore(homeDirectory).read(session.sessionId, run.runId);
      expect(parent.ok && parent.value.finished).toBe(true);
      expect(parent.ok && parent.value.events.some((e) => e.type.startsWith("task."))).toBe(false);
      const child = await new EventStore(homeDirectory, undefined, run.runId).read(
        session.sessionId,
        childRunId,
      );
      expect(child.ok && child.value.finished).toBe(true);
      expect(child.ok && child.value.events.some((e) => e.type.startsWith("task."))).toBe(true);
    } finally {
      await controller.dispose();
      await app.stop();
      await mock.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
