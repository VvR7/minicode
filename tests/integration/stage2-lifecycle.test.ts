import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_CREATE_METHOD,
  SESSION_GET_HISTORY_METHOD,
  SESSION_LIST_METHOD,
  SESSION_SEND_MESSAGE_METHOD,
  SessionCreateResultSchema,
  SessionGetHistoryResultSchema,
  SessionListResultSchema,
  SessionSendMessageResultSchema,
  type ClientMessageId,
} from "../../packages/protocol/src/index.ts";
import {
  NdjsonRpcConnection,
  SessionController,
  type SessionControllerEvent,
} from "../../packages/client/src/index.ts";
import { CoreApp } from "../../packages/core/src/index.ts";
import { TuiModel } from "../../packages/tui/src/model.ts";
import {
  createBarrier,
  startScriptedAnthropicMock,
  type ScriptedReply,
} from "./helpers/scripted-anthropic-mock.ts";

const SECRET = "stage2-secret-token";

/** 创建一组与生产 Core 相同的测试环境变量。 */
function environment(baseUrl: string, tracePayload: "summary" | "full" = "full") {
  return {
    LLM_API_KEY: SECRET,
    LLM_BASE_URL: baseUrl,
    LLM_MODEL: "stage2-test-model",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    MINICODE_TRACE_ENABLED: "true",
    MINICODE_TRACE_PAYLOAD: tracePayload,
  } as const;
}

/** 等待指定 controller 的下一条 turn.committed，不使用轮询或墙钟等待。 */
function nextCommit(events: SessionControllerEvent[]): {
  readonly promise: Promise<Extract<SessionControllerEvent, { type: "turn.committed" }>>;
  accept(event: SessionControllerEvent): void;
} {
  const result =
    Promise.withResolvers<Extract<SessionControllerEvent, { type: "turn.committed" }>>();
  return {
    promise: result.promise,
    /** 保存事件，并在权威终态到达时释放等待方。 */
    accept(event) {
      events.push(event);
      if (event.type === "turn.committed") result.resolve(event);
    },
  };
}

/** 从 provider 请求中读取 messages，未知结构返回空数组。 */
function messagesOf(body: unknown): readonly unknown[] {
  if (body === null || typeof body !== "object" || !("messages" in body)) return [];
  const messages = body.messages;
  return Array.isArray(messages) ? messages : [];
}

/** 递归列出目录中的相对路径，供 workspace 污染断言使用。 */
async function listTree(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    result.push(relative);
    if (entry.isDirectory()) result.push(...(await listTree(root, relative)));
  }
  return result.sort();
}

describe("Stage2 complete lifecycle", () => {
  test("keeps multi-client TUI projections synchronized across notes, tasks, replay and retries", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage2-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-stage2-workspace-"));
    await writeFile(join(workspace, "README.md"), "isolated workspace\n", "utf8");
    const streamBarrier = createBarrier();
    const busyBarrier = createBarrier();
    const replies = new Map<number, ScriptedReply>([
      [
        1,
        {
          kind: "tools",
          calls: [
            { id: "note-1", name: "note_save", input: { content: "remember stage two" } },
            {
              id: "task-1",
              name: "task_create",
              input: { subject: "Inspect", description: "Inspect the workspace" },
            },
          ],
        },
      ],
      [
        2,
        {
          kind: "tools",
          calls: [
            { id: "task-2", name: "task_update", input: { id: 1, status: "in_progress" } },
            { id: "task-3", name: "task_update", input: { id: 1, status: "completed" } },
          ],
        },
      ],
      [
        3,
        {
          kind: "text",
          chunks: ["first ", "answer"],
          barrier: streamBarrier,
          afterChunks: 1,
        },
      ],
      [4, { kind: "tools", calls: [{ id: "list-1", name: "task_list", input: {} }] }],
      [5, { kind: "text", chunks: ["second answer"] }],
      [6, { kind: "text", chunks: ["idempotent answer"] }],
      [7, { kind: "text", chunks: ["busy ", "winner"], barrier: busyBarrier, afterChunks: 1 }],
    ]);
    const mock = startScriptedAnthropicMock((_body, call) => {
      const reply = replies.get(call);
      if (reply === undefined) throw new Error(`unexpected provider call ${call}`);
      return reply;
    });
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      environment(mock.url),
    );
    const endpoint = app.start();
    const firstEvents: SessionControllerEvent[] = [];
    const secondEvents: SessionControllerEvent[] = [];
    const firstModel = new TuiModel();
    const secondModel = new TuiModel();
    let firstCommit = nextCommit(firstEvents);
    let secondCommit = nextCommit(secondEvents);
    const first = new SessionController({
      endpoint,
      onEvent: (event) => {
        firstModel.apply(event);
        firstCommit.accept(event);
      },
    });
    const second = new SessionController({
      endpoint,
      onEvent: (event) => {
        secondModel.apply(event);
        secondCommit.accept(event);
      },
    });
    const audit = await NdjsonRpcConnection.connect(endpoint);

    try {
      const session = await first.create(workspace);
      const accepted = await first.sendMessage(`Authorization: Bearer ${SECRET}`);
      await streamBarrier.reached;
      await second.attach(session.sessionId);
      streamBarrier.release();
      const [firstFinished, secondFinished] = await Promise.all([
        firstCommit.promise,
        secondCommit.promise,
      ]);
      expect(secondFinished).toEqual(firstFinished);
      expect(firstFinished.runId).toBe(accepted.runId);

      const firstText = firstModel.snapshot().lines.find((line) => line.kind === "assistant")?.text;
      const secondText = secondModel
        .snapshot()
        .lines.find((line) => line.kind === "assistant")?.text;
      expect(firstText).toBe("[ASSISTANT] first answer");
      expect(secondText).toBe(firstText);
      for (const events of [firstEvents, secondEvents]) {
        expect(
          events.filter(
            (event) =>
              event.type === "run.event" &&
              event.event.runId === accepted.runId &&
              event.event.type === "run.finished",
          ),
        ).toHaveLength(1);
      }

      firstCommit = nextCommit(firstEvents);
      secondCommit = nextCommit(secondEvents);
      await first.sendMessage("what did the previous run remember?");
      await Promise.all([firstCommit.promise, secondCommit.promise]);
      const secondRequest = mock.requestBodies[3];
      expect(JSON.stringify(messagesOf(secondRequest))).toContain("first answer");
      expect(JSON.stringify(secondRequest)).toContain("remember stage two");
      // 新 run 的 task_list 必须看到空图，证明 TaskManager 没有跨轮继承。
      expect(JSON.stringify(mock.requestBodies[4])).toContain('\\"tasks\\":[]');

      const runCountBeforeRetry = (await readdir(join(home, "sessions", session.sessionId, "runs")))
        .length;
      firstCommit = nextCommit(firstEvents);
      secondCommit = nextCommit(secondEvents);
      const duplicateId = crypto.randomUUID() as ClientMessageId;
      const duplicateParams = {
        sessionId: session.sessionId,
        clientMessageId: duplicateId,
        content: "retry exactly once",
      };
      const [original, retry] = await Promise.all([
        audit.request(SESSION_SEND_MESSAGE_METHOD, duplicateParams, SessionSendMessageResultSchema),
        audit.request(SESSION_SEND_MESSAGE_METHOD, duplicateParams, SessionSendMessageResultSchema),
      ]);
      expect(retry.result).toEqual(original.result);
      await Promise.all([firstCommit.promise, secondCommit.promise]);
      expect(mock.callCount).toBe(6);
      expect((await readdir(join(home, "sessions", session.sessionId, "runs"))).length).toBe(
        runCountBeforeRetry + 1,
      );

      firstCommit = nextCommit(firstEvents);
      secondCommit = nextCommit(secondEvents);
      const winning = audit.request(
        SESSION_SEND_MESSAGE_METHOD,
        {
          sessionId: session.sessionId,
          clientMessageId: crypto.randomUUID(),
          content: "winner",
        },
        SessionSendMessageResultSchema,
      );
      await busyBarrier.reached;
      await expect(
        audit.request(
          SESSION_SEND_MESSAGE_METHOD,
          {
            sessionId: session.sessionId,
            clientMessageId: crypto.randomUUID(),
            content: "must be busy",
          },
          SessionSendMessageResultSchema,
        ),
      ).rejects.toMatchObject({ code: -32011 });
      busyBarrier.release();
      await winning;
      await Promise.all([firstCommit.promise, secondCommit.promise]);

      const history = await audit.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId: session.sessionId },
        SessionGetHistoryResultSchema,
      );
      expect(history.result.turns).toHaveLength(4);
      expect(
        history.result.turns.filter((turn) => turn.clientMessageId === duplicateId),
      ).toHaveLength(1);
      expect(history.result.turns[0]?.taskGraph).toMatchObject({
        revision: 3,
        tasks: [{ id: 1, status: "completed" }],
      });

      const firstRunDirectory = join(home, "sessions", session.sessionId, "runs", accepted.runId);
      for (const path of [
        join(home, "sessions", session.sessionId, "meta.json"),
        join(home, "sessions", session.sessionId, "history.jsonl"),
        join(home, "sessions", session.sessionId, "notes.md"),
        join(home, "sessions", session.sessionId, "session-events.jsonl"),
        join(firstRunDirectory, "run.json"),
        join(firstRunDirectory, "events.jsonl"),
        join(firstRunDirectory, "trace.jsonl"),
        join(firstRunDirectory, "tasks.json"),
      ]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      expect((await stat(join(home, "sessions", session.sessionId))).mode & 0o777).toBe(0o700);
      expect((await stat(firstRunDirectory)).mode & 0o777).toBe(0o700);
      expect(await listTree(workspace)).toEqual(["README.md"]);

      const trace = await readFile(join(firstRunDirectory, "trace.jsonl"), "utf8");
      expect(trace).toContain("ipc.request_received");
      expect(trace).toContain("core.event_persisted");
      expect(trace).toContain("llm.request");
      expect(trace).toContain("llm.response");
      expect(trace).not.toContain(SECRET);
    } finally {
      audit.close();
      await Promise.all([first.dispose(), second.dispose()]);
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  }, 20_000);

  test("isolates concurrent sessions, cancellation, failures and later context", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage2-isolation-home-"));
    const firstWorkspace = await mkdtemp(join(tmpdir(), "minicode-stage2-isolation-a-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "minicode-stage2-isolation-b-"));
    const cancelBarrier = createBarrier();
    let contextCheckRequest: unknown;
    const mock = startScriptedAnthropicMock((body) => {
      const serialized = JSON.stringify(messagesOf(body));
      if (serialized.includes("cancel this turn"))
        return {
          kind: "text",
          chunks: ["partial cancellation", " must not survive"],
          barrier: cancelBarrier,
          afterChunks: 1,
        };
      if (serialized.includes("failed turn")) return { kind: "error" };
      if (serialized.includes("context check")) {
        contextCheckRequest = body;
        return { kind: "text", chunks: ["clean context"] };
      }
      return { kind: "text", chunks: ["other session succeeds"] };
    });
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      environment(mock.url),
    );
    const endpoint = app.start();
    const firstEvents: SessionControllerEvent[] = [];
    const secondEvents: SessionControllerEvent[] = [];
    let firstCommit = nextCommit(firstEvents);
    const secondCommit = nextCommit(secondEvents);
    const first = new SessionController({
      endpoint,
      onEvent: (event) => firstCommit.accept(event),
    });
    const second = new SessionController({
      endpoint,
      onEvent: (event) => secondCommit.accept(event),
    });

    try {
      const [firstSession, secondSession] = await Promise.all([
        first.create(firstWorkspace),
        second.create(secondWorkspace),
      ]);
      const cancelledSend = first.sendMessage(`cancel this turn Authorization: Bearer ${SECRET}`);
      await cancelBarrier.reached;
      const successfulSend = await second.sendMessage("other workspace question");
      expect(await first.cancelActiveRun()).toEqual({ outcome: "cancellation_requested" });
      cancelBarrier.release();
      const [cancelledAccepted, firstTerminal, secondTerminal] = await Promise.all([
        cancelledSend,
        firstCommit.promise,
        secondCommit.promise,
      ]);
      expect(firstTerminal).toMatchObject({
        runId: cancelledAccepted.runId,
        status: "cancelled",
      });
      expect(secondTerminal).toMatchObject({ runId: successfulSend.runId, status: "succeeded" });
      expect(
        firstEvents.some(
          (event) => "sessionId" in event && event.sessionId === secondSession.sessionId,
        ),
      ).toBe(false);
      expect(
        secondEvents.some(
          (event) => "sessionId" in event && event.sessionId === firstSession.sessionId,
        ),
      ).toBe(false);

      firstCommit = nextCommit(firstEvents);
      await first.sendMessage("failed turn");
      expect(await firstCommit.promise).toMatchObject({ status: "failed" });

      firstCommit = nextCommit(firstEvents);
      await first.sendMessage("context check");
      expect(await firstCommit.promise).toMatchObject({ status: "succeeded" });
      const nextContext = JSON.stringify(messagesOf(contextCheckRequest));
      expect(nextContext).not.toContain("cancel this turn");
      expect(nextContext).not.toContain("failed turn");

      const cancelledTrace = await readFile(
        join(
          home,
          "sessions",
          firstSession.sessionId,
          "runs",
          cancelledAccepted.runId,
          "trace.jsonl",
        ),
        "utf8",
      );
      expect(cancelledTrace).toContain("llm.cancelled");
      expect(cancelledTrace).not.toContain(SECRET);
      expect(await readdir(join(home, "sessions", secondSession.sessionId, "runs"))).toEqual([
        successfulSend.runId,
      ]);
    } finally {
      cancelBarrier.release();
      await Promise.all([first.dispose(), second.dispose()]);
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(firstWorkspace, { recursive: true, force: true }),
        rm(secondWorkspace, { recursive: true, force: true }),
      ]);
    }
  }, 20_000);

  test("rejects an over-budget turn before provider calls or run allocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage2-budget-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-stage2-budget-workspace-"));
    const mock = startScriptedAnthropicMock(() => ({ kind: "text", chunks: ["unexpected"] }));
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      {
        ...environment(mock.url, "summary"),
        LLM_CONTEXT_WINDOW_TOKENS: "100",
        LLM_MAX_OUTPUT_TOKENS: "99",
      },
    );
    const endpoint = app.start();
    const client = await NdjsonRpcConnection.connect(endpoint);

    try {
      const created = await client.request(
        SESSION_CREATE_METHOD,
        { workspaceRoot: workspace },
        SessionCreateResultSchema,
      );
      const sessionDirectory = join(home, "sessions", created.result.session.sessionId);
      const before = await listTree(sessionDirectory);
      await expect(
        client.request(
          SESSION_SEND_MESSAGE_METHOD,
          {
            sessionId: created.result.session.sessionId,
            clientMessageId: crypto.randomUUID(),
            content: "this message cannot fit",
          },
          SessionSendMessageResultSchema,
        ),
      ).rejects.toMatchObject({ code: -32013 });
      expect(mock.callCount).toBe(0);
      expect(await listTree(sessionDirectory)).toEqual(before);
      expect(await listTree(workspace)).toEqual([]);

      const listed = await client.request(
        SESSION_LIST_METHOD,
        { workspaceRoot: workspace },
        SessionListResultSchema,
      );
      expect(listed.result.sessions).toHaveLength(1);
      expect(listed.result.sessions[0]).toMatchObject({ status: "idle", mode: "chat" });
    } finally {
      client.close();
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  });
});
