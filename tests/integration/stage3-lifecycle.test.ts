import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NdjsonRpcConnection,
  SessionController,
  type SessionControllerEvent,
} from "../../packages/client/src/index.ts";
import { CoreApp, EventStore } from "../../packages/core/src/index.ts";
import {
  buildContextMessages,
  SessionStore,
} from "../../packages/core/src/session/session-store.ts";
import { ReadTool } from "../../packages/core/src/tools/builtin/read.ts";
import { ToolError } from "../../packages/core/src/tools/types.ts";
import {
  type AgentEvent,
  EventPushNotificationSchema,
  EventSubscribeResultSchema,
  isAgentEvent,
  PermissionRespondResultSchema,
  RunIdSchema,
  SessionIdSchema,
} from "../../packages/protocol/src/index.ts";
import {
  type ScriptedToolCall,
  startScriptedAnthropicMock,
} from "./helpers/scripted-anthropic-mock.ts";

/** 等待真实 IPC 投影达到切点，不通过固定延迟猜测事件顺序。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Stage3 lifecycle timed out");
    await Bun.sleep(5);
  }
}

/** 为每轮返回相同工具脚本，工具结果出现后返回最终文本。 */
async function fixture(calls: readonly ScriptedToolCall[]) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-stage3-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minicode-stage3-workspace-"));
  const mock = startScriptedAnthropicMock((body) => {
    const messages = (body as { messages: { role: string; content: { type: string }[] }[] })
      .messages;
    const last = messages.at(-1);
    return last?.content.some((block) => block.type === "tool_result")
      ? { kind: "text", chunks: ["done"] }
      : { kind: "tools", calls };
  });
  const app = new CoreApp(
    {
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      permissionMode: "alwaysask",
      homeDirectory,
    },
    {
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: mock.url,
      LLM_MODEL: "test-model",
      LLM_CONTEXT_WINDOW_TOKENS: "100000",
      LLM_MAX_OUTPUT_TOKENS: "4096",
      MINICODE_TRACE_ENABLED: "false",
    },
  );
  const endpoint = app.start();
  const controllers: SessionController[] = [];
  const connection = await NdjsonRpcConnection.connect(endpoint);
  return {
    homeDirectory,
    workspaceRoot,
    connection,
    /** 创建真实 session 客户端，并保留完整消费后的 run 事件。 */
    client() {
      const events: SessionControllerEvent[] = [];
      const controller = new SessionController({
        endpoint,
        onEvent: (event) => {
          events.push(event);
        },
      });
      controllers.push(controller);
      return {
        controller,
        events,
        /** 从 session timeline 提取当前 run 的权威事件。 */
        runEvents(runId: string): AgentEvent[] {
          return events.flatMap((event) =>
            event.type === "run.event" && event.event.runId === runId ? [event.event] : [],
          );
        },
        /** 等待 history 已提交，而不是仅等待工具结束。 */
        async committed(runId: string) {
          await waitFor(() =>
            events.some((event) => event.type === "turn.committed" && event.runId === runId),
          );
        },
      };
    },
    /** 只清理本测试创建的连接、进程与目录。 */
    async cleanup() {
      await Promise.all(controllers.map((controller) => controller.dispose()));
      connection.close();
      await app.stop();
      await mock.stop();
      await rm(homeDirectory, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

describe("Stage3 complete lifecycle (integration)", () => {
  test("unchanged Stage2 disk fixtures remain readable as history and tool journals", async () => {
    const f = await fixture([]);
    const sessionId = SessionIdSchema.parse("550e8400-e29b-41d4-a716-446655440100");
    const runId = RunIdSchema.parse("550e8400-e29b-41d4-a716-446655440300");
    try {
      const directory = join(f.homeDirectory, "sessions", sessionId);
      await mkdir(join(directory, "runs", runId), { recursive: true });
      await writeFile(
        join(directory, "meta.json"),
        JSON.stringify({
          schemaVersion: 1,
          sessionId,
          mode: "chat",
          workspaceRoot: f.workspaceRoot,
          title: "Stage2 session",
          createdAt: "2026-09-14T08:00:00.000Z",
          updatedAt: "2026-09-14T08:00:01.000Z",
        }),
      );
      await writeFile(join(directory, "notes.md"), "");
      await writeFile(join(directory, "session-events.jsonl"), "");
      const history = await readFile(join(import.meta.dir, "helpers/stage2-history.jsonl"), "utf8");
      const events = await readFile(
        join(import.meta.dir, "helpers/stage2-tool-events.jsonl"),
        "utf8",
      );
      // 原样复制冻结记录，不经过新 schema 生成，避免兼容测试自证。
      await writeFile(join(directory, "history.jsonl"), history);
      await writeFile(join(directory, "runs", runId, "events.jsonl"), events);
      const loaded = await new SessionStore(f.homeDirectory).load(sessionId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error("legacy history unreadable");
      expect(loaded.value.turns[0]?.status).toBe("succeeded");
      expect(buildContextMessages(loaded.value.turns)).toHaveLength(4);
      expect(loaded.value.turns[0]?.messages[1]?.content[0]).toMatchObject({
        type: "tool_use",
        name: "read_file",
      });
      const journal = await new EventStore(f.homeDirectory).read(sessionId, runId);
      expect(journal.ok && journal.value.events).toHaveLength(2);
      expect(await readFile(join(directory, "history.jsonl"), "utf8")).toBe(history);
      expect(await readFile(join(directory, "runs", runId, "events.jsonl"), "utf8")).toBe(events);
    } finally {
      await f.cleanup();
    }
  });
  test("invalid model arguments and forced dangerous denial become observations without approval or retry", async () => {
    const f = await fixture([
      { id: "invalid", name: "write", input: { path: "never.txt", content: 123 } },
      { id: "dangerous", name: "bash", input: { command: "rm -rf /" } },
    ]);
    const client = f.client();
    try {
      await client.controller.create(f.workspaceRoot);
      const run = await client.controller.sendMessage("validate and deny");
      await client.committed(run.runId);
      const events = client.runEvents(run.runId);
      expect(
        events.some(
          (event) => event.type === "permission.requested" || event.type === "tool.retrying",
        ),
      ).toBe(false);
      const terminals = events.filter((event) => event.type === "tool.finished");
      expect(terminals).toHaveLength(2);
      expect(terminals[0]).toMatchObject({
        payload: {
          isError: true,
          attempts: 0,
          failureCategory: "schema_error",
          errorCode: "invalid_params",
        },
      });
      expect(terminals[1]).toMatchObject({
        payload: {
          isError: true,
          attempts: 0,
          failureCategory: "permission_denied",
          permissionSource: "policy",
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.finished",
        payload: { status: "succeeded" },
      });
      await expect(readFile(join(f.workspaceRoot, "never.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("approved bash timeout executes once, persists its failure, and replays a successful turn", async () => {
    const f = await fixture([
      { id: "slow", name: "bash", input: { command: "sleep 30", timeout: 1 } },
    ]);
    const client = f.client();
    try {
      const session = await client.controller.create(f.workspaceRoot);
      const run = await client.controller.sendMessage("timeout");
      await waitFor(() =>
        client.controller.permissions.some((permission) => permission.status === "pending"),
      );
      const pending = client.controller.permissions[0];
      if (!pending) throw new Error("missing permission");
      await client.controller.respondPermission(
        run.runId,
        pending.request.payload.permissionRequestId,
        "allow_once",
      );
      await client.committed(run.runId);
      const events = client.runEvents(run.runId);
      expect(events.find((event) => event.type === "tool.finished")).toMatchObject({
        payload: {
          attempts: 1,
          failureCategory: "timeout",
          errorCode: "tool_timeout",
          permissionSource: "user",
        },
      });
      expect(events.some((event) => event.type === "tool.retrying")).toBe(false);
      const replay: AgentEvent[] = [];
      f.connection.onNotification((notification) => {
        const parsed = EventPushNotificationSchema.safeParse(notification);
        if (parsed.success && isAgentEvent(parsed.data.params.event))
          replay.push(parsed.data.params.event);
      });
      await f.connection.request(
        "event.subscribe",
        { sessionId: session.sessionId, runId: run.runId },
        EventSubscribeResultSchema,
      );
      await waitFor(() => replay.some((event) => event.type === "run.finished"));
      expect(replay.filter((event) => event.type === "permission.resolved")).toHaveLength(1);
      expect(replay.find((event) => event.type === "tool.finished")).toMatchObject({
        payload: { failureCategory: "timeout" },
      });
      const journal = await new EventStore(f.homeDirectory).read(session.sessionId, run.runId);
      expect(journal.ok && journal.value.finished).toBe(true);
      expect(
        journal.ok && journal.value.events.filter((event) => event.type === "permission.resolved"),
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  for (const errorCode of ["temporary_io_error", "rate_limited"] as const) {
    test(`explicit ${errorCode} retries through real Core IPC before the terminal observation`, async () => {
      // 仅替换只读工具的故障点；仍使用真实注册表、权限、退避、AgentLoop 和 IPC。
      const original = ReadTool.prototype.execute;
      let attempts = 0;
      const fault = spyOn(ReadTool.prototype, "execute").mockImplementation(async function (
        this: ReadTool,
        params,
        context,
      ) {
        if (params.path !== "stage3-retry-fixture.txt") return original.call(this, params, context);
        attempts += 1;
        if (attempts === 1) throw new ToolError(errorCode, "scripted transient failure");
        return { content: "recovered" };
      });
      const f = await fixture([
        { id: "retry", name: "read", input: { path: "stage3-retry-fixture.txt" } },
      ]);
      const client = f.client();
      try {
        await client.controller.create(f.workspaceRoot);
        const run = await client.controller.sendMessage("retry transient read");
        await client.committed(run.runId);
        const events = client.runEvents(run.runId);
        const retry = events.find((event) => event.type === "tool.retrying");
        expect(retry).toMatchObject({
          durable: true,
          payload: { attempt: 2, maxAttempts: 3, delayMs: 2000, errorCode },
        });
        expect(attempts).toBe(2);
        expect(events.find((event) => event.type === "tool.finished")).toMatchObject({
          payload: { isError: false, attempts: 2, permissionSource: "policy" },
        });
        expect(events.indexOf(retry as AgentEvent)).toBeLessThan(
          events.findIndex((event) => event.type === "tool.finished"),
        );
      } finally {
        fault.mockRestore();
        await f.cleanup();
      }
    }, 10000);
  }

  test("always deny is isolated by session, and foreign identities cannot resolve another pending request", async () => {
    const f = await fixture([
      { id: "write", name: "write", input: { path: "isolated.txt", content: "session B" } },
    ]);
    const a = f.client();
    const b = f.client();
    try {
      const sessionA = await a.controller.create(f.workspaceRoot);
      const sessionB = await b.controller.create(f.workspaceRoot);
      const runA = await a.controller.sendMessage("deny A");
      const runB = await b.controller.sendMessage("allow B");
      await waitFor(
        () => a.controller.permissions.length === 1 && b.controller.permissions.length === 1,
      );
      const requestA = a.controller.permissions[0]?.request;
      const requestB = b.controller.permissions[0]?.request;
      if (!requestA || !requestB) throw new Error("missing isolated approvals");
      expect(a.runEvents(runA.runId).every((event) => event.sessionId === sessionA.sessionId)).toBe(
        true,
      );
      expect(b.runEvents(runB.runId).every((event) => event.sessionId === sessionB.sessionId)).toBe(
        true,
      );
      expect(
        a.events.some(
          (event) => event.type === "run.event" && event.event.sessionId === sessionB.sessionId,
        ),
      ).toBe(false);
      expect(
        b.events.some(
          (event) => event.type === "run.event" && event.event.sessionId === sessionA.sessionId,
        ),
      ).toBe(false);
      // 即便拼出已知 session/run，错配的 Core request ID 也不能授权。
      await f.connection.request(
        "event.subscribe",
        { sessionId: sessionA.sessionId, runId: runA.runId },
        EventSubscribeResultSchema,
      );
      expect(
        (
          await f.connection.request(
            "permission.respond",
            {
              sessionId: sessionB.sessionId,
              runId: runB.runId,
              permissionRequestId: requestB.payload.permissionRequestId,
              decision: "allow_once",
            },
            PermissionRespondResultSchema,
          )
        ).result.outcome,
      ).toBe("not_found");
      expect(
        (
          await f.connection.request(
            "permission.respond",
            {
              sessionId: sessionA.sessionId,
              runId: runA.runId,
              permissionRequestId: requestB.payload.permissionRequestId,
              decision: "allow_once",
            },
            PermissionRespondResultSchema,
          )
        ).result.outcome,
      ).toBe("not_found");
      await a.controller.respondPermission(
        runA.runId,
        requestA.payload.permissionRequestId,
        "always_deny",
      );
      await a.committed(runA.runId);
      expect(b.controller.permissions[0]?.status).toBe("pending");
      const nextA = await a.controller.sendMessage("cached deny A");
      await a.committed(nextA.runId);
      expect(a.runEvents(nextA.runId).some((event) => event.type === "permission.requested")).toBe(
        false,
      );
      expect(
        a.runEvents(nextA.runId).find((event) => event.type === "tool.finished"),
      ).toMatchObject({
        payload: {
          attempts: 0,
          failureCategory: "permission_denied",
          permissionSource: "session_cache",
        },
      });
      await expect(readFile(join(f.workspaceRoot, "isolated.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await b.controller.respondPermission(
        runB.runId,
        requestB.payload.permissionRequestId,
        "allow_once",
      );
      await b.committed(runB.runId);
      expect(await readFile(join(f.workspaceRoot, "isolated.txt"), "utf8")).toBe("session B");
    } finally {
      await f.cleanup();
    }
  });

  test("cancelling during real tool retry backoff prevents the second execution", async () => {
    const original = ReadTool.prototype.execute;
    let attempts = 0;
    const fault = spyOn(ReadTool.prototype, "execute").mockImplementation(async function (
      this: ReadTool,
      params,
      context,
    ) {
      if (params.path !== "stage3-cancel-fixture.txt") return original.call(this, params, context);
      attempts += 1;
      throw new ToolError("temporary_io_error", "scripted transient failure");
    });
    const f = await fixture([
      { id: "cancel-retry", name: "read", input: { path: "stage3-cancel-fixture.txt" } },
    ]);
    const client = f.client();
    try {
      await client.controller.create(f.workspaceRoot);
      const run = await client.controller.sendMessage("cancel backoff");
      await waitFor(() =>
        client.runEvents(run.runId).some((event) => event.type === "tool.retrying"),
      );
      expect(await client.controller.cancelActiveRun()).toEqual({
        outcome: "cancellation_requested",
      });
      await client.committed(run.runId);
      expect(attempts).toBe(1);
      const events = client.runEvents(run.runId);
      expect(events.find((event) => event.type === "tool.finished")).toMatchObject({
        payload: { attempts: 1, failureCategory: "cancelled", errorCode: "tool_cancelled" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.finished",
        payload: { status: "cancelled" },
      });
    } finally {
      fault.mockRestore();
      await f.cleanup();
    }
  });
});
