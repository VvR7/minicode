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
  type RunId,
  type TurnId,
} from "../../packages/protocol/src/index.ts";
import {
  NdjsonRpcConnection,
  SessionController,
  type SessionControllerEvent,
} from "../../packages/client/src/index.ts";
import {
  CoreApp,
  EventBus,
  EventStore,
  RunMetadataStore,
  SessionStore,
} from "../../packages/core/src/index.ts";
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

/** 解包测试准备阶段必须成功的领域结果。 */
function must<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("expected test setup to succeed");
  return result.value;
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
    const lostResponseBarrier = createBarrier();
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
      [
        6,
        {
          kind: "text",
          chunks: ["idempotent answer"],
          barrier: lostResponseBarrier,
          afterChunks: 1,
        },
      ],
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
    let slow: SessionController | undefined;
    let releaseSlow = (): void => {};

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
      expect(
        secondEvents
          .filter((event) => event.type === "run.event" && event.event.runId === accepted.runId)
          .map((event) => (event.type === "run.event" ? event.event : undefined)),
      ).toEqual(
        firstEvents
          .filter((event) => event.type === "run.event" && event.event.runId === accepted.runId)
          .map((event) => (event.type === "run.event" ? event.event : undefined)),
      );
      const firstAcceptedEvent = firstEvents.find(
        (event) => event.type === "turn.accepted" && event.runId === accepted.runId,
      );
      const secondSnapshot = secondEvents.find(
        (event) => event.type === "turn.snapshot" && event.turn.runId === accepted.runId,
      );
      expect(firstAcceptedEvent).toMatchObject({
        clientMessageId:
          secondSnapshot?.type === "turn.snapshot" ? secondSnapshot.turn.clientMessageId : "",
        turnId: secondSnapshot?.type === "turn.snapshot" ? secondSnapshot.turn.turnId : "",
        runId: secondSnapshot?.type === "turn.snapshot" ? secondSnapshot.turn.runId : "",
      });

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
      const lostConnection = await NdjsonRpcConnection.connect(endpoint);
      const droppedResponse = lostConnection.request(
        SESSION_SEND_MESSAGE_METHOD,
        duplicateParams,
        SessionSendMessageResultSchema,
      );
      lostConnection.close();
      void droppedResponse.catch(() => {});
      await lostResponseBarrier.reached;
      const retry = await audit.request(
        SESSION_SEND_MESSAGE_METHOD,
        duplicateParams,
        SessionSendMessageResultSchema,
      );
      lostResponseBarrier.release();
      await Promise.all([firstCommit.promise, secondCommit.promise]);
      expect(mock.callCount).toBe(6);
      expect((await readdir(join(home, "sessions", session.sessionId, "runs"))).length).toBe(
        runCountBeforeRetry + 1,
      );

      firstCommit = nextCommit(firstEvents);
      secondCommit = nextCommit(secondEvents);
      const slowReached = Promise.withResolvers<void>();
      const slowRelease = Promise.withResolvers<void>();
      releaseSlow = slowRelease.resolve;
      const slowCommitted =
        Promise.withResolvers<Extract<SessionControllerEvent, { type: "turn.committed" }>>();
      const slowModel = new TuiModel();
      slow = new SessionController({
        endpoint,
        /** 故意阻塞一个 delta consumer，验证它不会拖住其他同 session 客户端。 */
        onEvent: async (event) => {
          slowModel.apply(event);
          if (event.type === "run.event" && event.event.type === "llm.text_delta") {
            slowReached.resolve();
            await slowRelease.promise;
          }
          if (event.type === "turn.committed") slowCommitted.resolve(event);
        },
      });
      await slow.attach(session.sessionId);
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
      await slowReached.promise;
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
      slowRelease.resolve();
      const slowTerminal = await slowCommitted.promise;
      expect(slowTerminal.status).toBe("succeeded");
      expect(
        slowModel
          .snapshot()
          .lines.filter((line) => line.kind === "assistant")
          .at(-1)?.text,
      ).toBe("[ASSISTANT] busy winner");

      const history = await audit.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId: session.sessionId },
        SessionGetHistoryResultSchema,
      );
      expect(history.result.turns).toHaveLength(4);
      expect(
        history.result.turns.filter((turn) => turn.clientMessageId === duplicateId),
      ).toHaveLength(1);
      expect(
        history.result.turns.find((turn) => turn.clientMessageId === duplicateId),
      ).toMatchObject({ turnId: retry.result.turnId, runId: retry.result.runId });
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
      streamBarrier.release();
      lostResponseBarrier.release();
      busyBarrier.release();
      releaseSlow();
      audit.close();
      await Promise.all([first.dispose(), second.dispose(), slow?.dispose()]);
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
      if (serialized.includes("other workspace question"))
        return serialized.includes('"type":"tool_result"')
          ? { kind: "text", chunks: ["other session succeeds"] }
          : {
              kind: "tools",
              calls: [
                {
                  id: "task-b",
                  name: "task_create",
                  input: { subject: "Session B", description: "Must stay in session B" },
                },
              ],
            };
      throw new Error("unexpected scripted request");
    });
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      environment(mock.url),
    );
    const endpoint = app.start();
    const firstEvents: SessionControllerEvent[] = [];
    const secondEvents: SessionControllerEvent[] = [];
    const cancelledObserverEvents: SessionControllerEvent[] = [];
    let firstCommit = nextCommit(firstEvents);
    const secondCommit = nextCommit(secondEvents);
    const cancelledObserverCommit = nextCommit(cancelledObserverEvents);
    const first = new SessionController({
      endpoint,
      onEvent: (event) => firstCommit.accept(event),
    });
    const second = new SessionController({
      endpoint,
      onEvent: (event) => secondCommit.accept(event),
    });
    const cancelledObserver = new SessionController({
      endpoint,
      onEvent: (event) => cancelledObserverCommit.accept(event),
    });

    try {
      const [firstSession, secondSession] = await Promise.all([
        first.create(firstWorkspace),
        second.create(secondWorkspace),
      ]);
      await cancelledObserver.attach(firstSession.sessionId);
      const cancelledSend = first.sendMessage(`cancel this turn Authorization: Bearer ${SECRET}`);
      await cancelBarrier.reached;
      const successfulSend = await second.sendMessage("other workspace question");
      expect(await first.cancelActiveRun()).toEqual({ outcome: "cancellation_requested" });
      cancelBarrier.release();
      const [cancelledAccepted, firstTerminal, secondTerminal, observerTerminal] =
        await Promise.all([
          cancelledSend,
          firstCommit.promise,
          secondCommit.promise,
          cancelledObserverCommit.promise,
        ]);
      expect(firstTerminal).toMatchObject({
        runId: cancelledAccepted.runId,
        status: "cancelled",
      });
      expect(secondTerminal).toMatchObject({ runId: successfulSend.runId, status: "succeeded" });
      expect(observerTerminal).toEqual(firstTerminal);
      expect(
        cancelledObserverEvents.filter(
          (event) =>
            event.type === "run.event" &&
            event.event.runId === cancelledAccepted.runId &&
            event.event.type === "run.finished" &&
            event.event.payload.status === "cancelled",
        ),
      ).toHaveLength(1);
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
      const firstHistory = await first.list({ workspaceRoot: firstWorkspace });
      const secondHistory = await second.list({
        workspaceRoot: secondWorkspace,
      });
      expect(firstHistory.sessions.map((session) => session.sessionId)).toEqual([
        firstSession.sessionId,
      ]);
      expect(secondHistory.sessions.map((session) => session.sessionId)).toEqual([
        secondSession.sessionId,
      ]);

      const firstRunDirectory = join(
        home,
        "sessions",
        firstSession.sessionId,
        "runs",
        cancelledAccepted.runId,
      );
      const secondRunDirectory = join(
        home,
        "sessions",
        secondSession.sessionId,
        "runs",
        successfulSend.runId,
      );
      expect(await Bun.file(join(firstRunDirectory, "tasks.json")).exists()).toBe(false);
      expect(
        JSON.parse(await readFile(join(secondRunDirectory, "tasks.json"), "utf8")),
      ).toMatchObject({ revision: 1, tasks: [{ subject: "Session B" }] });
      expect(await readFile(join(firstRunDirectory, "trace.jsonl"), "utf8")).not.toContain(
        secondSession.sessionId,
      );
      expect(await readFile(join(secondRunDirectory, "trace.jsonl"), "utf8")).not.toContain(
        firstSession.sessionId,
      );

      firstCommit = nextCommit(firstEvents);
      await first.sendMessage("failed turn");
      const failedTerminal = await firstCommit.promise;
      expect(failedTerminal).toMatchObject({ status: "failed" });

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
      expect(
        await readFile(
          join(
            home,
            "sessions",
            firstSession.sessionId,
            "runs",
            failedTerminal.runId,
            "trace.jsonl",
          ),
          "utf8",
        ),
      ).toContain("llm.error");
      expect(await readdir(join(home, "sessions", secondSession.sessionId, "runs"))).toEqual([
        successfulSend.runId,
      ]);
    } finally {
      cancelBarrier.release();
      await Promise.all([first.dispose(), second.dispose(), cancelledObserver.dispose()]);
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(firstWorkspace, { recursive: true, force: true }),
        rm(secondWorkspace, { recursive: true, force: true }),
      ]);
    }
  }, 20_000);

  test("reconciles crash cuts deterministically and isolates a conflicting session", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage2-recovery-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-stage2-recovery-workspace-"));
    const sessions = new SessionStore(home);
    const metadata = new RunMetadataStore(home);
    const eventStore = new EventStore(home);
    const eventBus = new EventBus(eventStore);

    /** 在真实磁盘写入 accepted 状态，模拟 Core 在后续终态切点前崩溃。 */
    const seedAccepted = async (goal: string) => {
      const session = must(await sessions.create({ workspaceRoot: workspace, mode: "chat" }));
      const turnId = crypto.randomUUID() as TurnId;
      const runId = crypto.randomUUID() as RunId;
      await sessions.appendAccepted(session.meta.sessionId, {
        turnId,
        runId,
        clientMessageId: crypto.randomUUID() as ClientMessageId,
        userMessage: goal,
      });
      await metadata.create({
        sessionId: session.meta.sessionId,
        turnId,
        runId,
        workspaceRoot: workspace,
        model: "stage2-test-model",
      });
      return { sessionId: session.meta.sessionId, turnId, runId };
    };

    const interrupted = await seedAccepted("unfinished crash turn");
    await eventBus.publish({
      sessionId: interrupted.sessionId,
      runId: interrupted.runId,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "run.started",
      payload: {},
    });

    const historyCompleted = await seedAccepted("history committed before crash");
    await sessions.appendCompleted(historyCompleted.sessionId, {
      turnId: historyCompleted.turnId,
      runId: historyCompleted.runId,
      status: "succeeded",
      reason: "completed",
      messages: [
        {
          messageId: crypto.randomUUID(),
          turnId: historyCompleted.turnId,
          runId: historyCompleted.runId,
          role: "user",
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "history committed before crash" }],
        },
        {
          messageId: crypto.randomUUID(),
          turnId: historyCompleted.turnId,
          runId: historyCompleted.runId,
          role: "assistant",
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "durable answer" }],
        },
      ],
      model: "stage2-test-model",
      runResult: {
        status: "succeeded",
        reason: "completed",
        finalText: "durable answer",
        steps: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });

    const conflicting = await seedAccepted("conflicting terminal");
    await sessions.appendCompleted(conflicting.sessionId, {
      turnId: conflicting.turnId,
      runId: conflicting.runId,
      status: "succeeded",
      reason: "completed",
      messages: [
        {
          messageId: crypto.randomUUID(),
          turnId: conflicting.turnId,
          runId: conflicting.runId,
          role: "user",
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "conflicting terminal" }],
        },
        {
          messageId: crypto.randomUUID(),
          turnId: conflicting.turnId,
          runId: conflicting.runId,
          role: "assistant",
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "expected answer" }],
        },
      ],
      model: "stage2-test-model",
      runResult: {
        status: "succeeded",
        reason: "completed",
        finalText: "expected answer",
        steps: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    await eventBus.publish({
      sessionId: conflicting.sessionId,
      runId: conflicting.runId,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "run.finished",
      payload: {
        status: "failed",
        reason: "llm_error",
        finalText: "",
        steps: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        error: { code: "llm_error", message: "run failed (llm_error)" },
      },
    });

    let followUpRequest: unknown;
    const mock = startScriptedAnthropicMock((body) => {
      followUpRequest = body;
      return { kind: "text", chunks: ["recovered cleanly"] };
    });
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      environment(mock.url, "summary"),
    );
    const endpoint = app.start();
    const model = new TuiModel();
    const controllerEvents: SessionControllerEvent[] = [];
    let committed = nextCommit(controllerEvents);
    const controller = new SessionController({
      endpoint,
      onEvent: (event) => {
        model.apply(event);
        committed.accept(event);
      },
    });
    const audit = await NdjsonRpcConnection.connect(endpoint);

    try {
      await controller.attach(interrupted.sessionId);
      expect(model.snapshot().lines.some((line) => line.text.includes("interrupted"))).toBe(true);
      committed = nextCommit(controllerEvents);
      await controller.sendMessage("after recovery");
      await committed.promise;
      expect(JSON.stringify(messagesOf(followUpRequest))).not.toContain("unfinished crash turn");

      const interruptedHistory = await audit.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId: interrupted.sessionId },
        SessionGetHistoryResultSchema,
      );
      expect(interruptedHistory.result.turns.map((turn) => turn.status)).toEqual([
        "interrupted",
        "succeeded",
      ]);
      expect(interruptedHistory.result.turns[0]?.includedInContext).toBe(false);
      const interruptedJournal = must(
        await eventStore.read(interrupted.sessionId, interrupted.runId),
      );
      expect(
        interruptedJournal.events.filter((event) => event.type === "run.finished"),
      ).toHaveLength(1);
      expect(
        must(await sessions.load(interrupted.sessionId)).sessionEvents.filter(
          (event) =>
            event.type === "session.turn_finished" && event.payload.turnId === interrupted.turnId,
        ),
      ).toHaveLength(1);

      const repairedHistory = await audit.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId: historyCompleted.sessionId },
        SessionGetHistoryResultSchema,
      );
      expect(repairedHistory.result.turns).toHaveLength(1);
      expect(
        must(
          await eventStore.read(historyCompleted.sessionId, historyCompleted.runId),
        ).events.filter((event) => event.type === "run.finished"),
      ).toHaveLength(1);
      expect(
        must(await sessions.load(historyCompleted.sessionId)).sessionEvents.filter(
          (event) =>
            event.type === "session.turn_finished" &&
            event.payload.turnId === historyCompleted.turnId,
        ),
      ).toHaveLength(1);

      const listed = await controller.list({ workspaceRoot: workspace });
      expect(
        listed.sessions.find((session) => session.sessionId === conflicting.sessionId)?.status,
      ).toBe("corrupted");
      expect(
        listed.sessions.find((session) => session.sessionId === interrupted.sessionId)?.status,
      ).toBe("idle");

      const summaryTrace = await readFile(
        join(
          home,
          "sessions",
          interrupted.sessionId,
          "runs",
          interruptedHistory.result.turns[1]?.runId ?? "missing",
          "trace.jsonl",
        ),
        "utf8",
      );
      expect(summaryTrace).toContain("[summarized]");
      expect(summaryTrace).not.toContain("after recovery");
      expect(summaryTrace).not.toContain(SECRET);
    } finally {
      audit.close();
      await controller.dispose();
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  }, 20_000);

  test("daemon shutdown commits one cancelled terminal that a restarted Core can audit", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage2-shutdown-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-stage2-shutdown-workspace-"));
    const shutdownBarrier = createBarrier();
    const firstMock = startScriptedAnthropicMock(() => ({
      kind: "text",
      chunks: ["before shutdown", "ignored completion"],
      barrier: shutdownBarrier,
      afterChunks: 1,
    }));
    const firstApp = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      environment(firstMock.url),
    );
    const firstEndpoint = firstApp.start();
    const firstController = new SessionController({ endpoint: firstEndpoint, onEvent: () => {} });

    try {
      const session = await firstController.create(workspace);
      const accepted = await firstController.sendMessage("shutdown active run");
      await shutdownBarrier.reached;
      await firstController.dispose();
      const stopping = firstApp.stop();
      shutdownBarrier.release();
      await stopping;
      await firstMock.stop();

      const secondMock = startScriptedAnthropicMock(() => ({
        kind: "text",
        chunks: ["unused"],
      }));
      const secondApp = new CoreApp(
        { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
        environment(secondMock.url),
      );
      const secondEndpoint = secondApp.start();
      const model = new TuiModel();
      const secondController = new SessionController({
        endpoint: secondEndpoint,
        onEvent: (event) => {
          model.apply(event);
        },
      });
      const audit = await NdjsonRpcConnection.connect(secondEndpoint);
      try {
        await secondController.attach(session.sessionId);
        const history = await audit.request(
          SESSION_GET_HISTORY_METHOD,
          { sessionId: session.sessionId },
          SessionGetHistoryResultSchema,
        );
        expect(history.result.turns).toHaveLength(1);
        expect(history.result.turns[0]).toMatchObject({
          runId: accepted.runId,
          status: "cancelled",
          includedInContext: false,
        });
        expect(model.snapshot().lines.some((line) => line.text.includes("cancelled"))).toBe(true);
        expect(
          must(await new EventStore(home).read(session.sessionId, accepted.runId)).events.filter(
            (event) => event.type === "run.finished",
          ),
        ).toHaveLength(1);
        expect(
          must(await new SessionStore(home).load(session.sessionId)).sessionEvents.filter(
            (event) =>
              event.type === "session.turn_finished" && event.payload.runId === accepted.runId,
          ),
        ).toHaveLength(1);
      } finally {
        audit.close();
        await secondController.dispose();
        await secondApp.stop();
        await secondMock.stop();
      }
    } finally {
      shutdownBarrier.release();
      await firstController.dispose();
      await firstApp.stop();
      await firstMock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
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
        MINICODE_COMPACTION_RESERVE_TOKENS: "20",
        MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "20",
        LLM_MAX_OUTPUT_TOKENS: "10",
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
