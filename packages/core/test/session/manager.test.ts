import { describe, expect, test } from "bun:test";
import type { ClientMessageId, Environment, HistoryTurnReason } from "@minicode/protocol";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { SessionEventBus } from "../../src/events/session-event-bus.ts";
import type { LlmMessage } from "../../src/llm/types.ts";
import type { AgentRunOutcome, AgentRunRequest } from "../../src/run/runner.ts";
import { RunMetadataStore } from "../../src/run/metadata.ts";
import {
  SessionManager,
  type SessionManagerOptions,
  type SessionRunExecutor,
} from "../../src/session/manager.ts";
import { SessionStore } from "../../src/session/session-store.ts";
import { RunTraceRegistry } from "../../src/trace/registry.ts";
import { MemoryJournalStorage } from "../agent/test-helpers.ts";
import {
  CLIENT_MESSAGE_A,
  CLIENT_MESSAGE_B,
  CLIENT_MESSAGE_C,
  MemorySessionStorage,
  RUN_A,
  RUN_B,
  RUN_C,
  TURN_A,
  TURN_B,
  TURN_C,
} from "./test-helpers.ts";

const HOME = "/memory-home";
const ENVIRONMENT: Environment = {
  LLM_MODEL: "test-model",
  LLM_CONTEXT_WINDOW_TOKENS: "100000",
  LLM_MAX_OUTPUT_TOKENS: "4096",
  MINICODE_TRACE_ENABLED: "false",
};
const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
} as const;

type RunnerBehavior = (request: AgentRunRequest, signal: AbortSignal) => Promise<AgentRunOutcome>;

/** 记录请求并按测试脚本返回 completion 的最小 Runner。 */
class StubRunner implements SessionRunExecutor {
  readonly requests: AgentRunRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly #behavior: RunnerBehavior;

  constructor(behavior: RunnerBehavior) {
    this.#behavior = behavior;
  }

  /** 保存隔离身份与上下文后执行当前测试脚本。 */
  async run(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunOutcome> {
    this.requests.push(request);
    this.signals.push(signal);
    return this.#behavior(request, signal);
  }
}

/** 仅让 turn.completed 的 history append 失败，用于验证 corrupted 降级。 */
class FailingCompletionStorage extends MemorySessionStorage {
  failCompletion = false;

  /** 其他 append 保持正常，只注入一次 completion journal 故障。 */
  override async appendLine(path: string, line: string): Promise<void> {
    if (this.failCompletion && line.includes('"kind":"turn.completed"')) {
      this.failCompletion = false;
      throw new Error("completion write failed");
    }
    await super.appendLine(path, line);
  }
}

/** 阻塞首个 accepted run.json 写入，用于制造 admission 与 shutdown 竞态。 */
class BlockingRunMetadataStorage extends MemorySessionStorage {
  readonly writeStarted = Promise.withResolvers<void>();
  readonly writeGate = Promise.withResolvers<void>();
  blockAcceptedMetadata = true;

  /** 仅阻塞 run.json accepted 初态，其他原子写保持正常。 */
  override async writeFileAtomic(path: string, content: string): Promise<void> {
    if (
      this.blockAcceptedMetadata &&
      path.endsWith("/run.json") &&
      content.includes('"status": "accepted"')
    ) {
      this.blockAcceptedMetadata = false;
      this.writeStarted.resolve();
      await this.writeGate.promise;
    }
    await super.writeFileAtomic(path, content);
  }
}

/** 阻塞 one_shot 的 meta 写入，用于制造 create 完成前的 shutdown 竞态。 */
class BlockingOneShotCreateStorage extends MemorySessionStorage {
  readonly metaWriteStarted = Promise.withResolvers<void>();
  readonly metaWriteGate = Promise.withResolvers<void>();

  /** 仅阻塞 one_shot session 的初始 meta，避免影响后续 run.json。 */
  override async writeFileAtomic(path: string, content: string): Promise<void> {
    if (path.endsWith("/meta.json") && content.includes('"mode": "one_shot"')) {
      this.metaWriteStarted.resolve();
      await this.metaWriteGate.promise;
    }
    await super.writeFileAtomic(path, content);
  }
}

/** 阻塞 run.finished journal append，用于验证 shutdown 会等待已清 active 的终态提交。 */
class BlockingTerminalJournalStorage extends MemoryJournalStorage {
  readonly terminalStarted = Promise.withResolvers<void>();
  readonly terminalGate = Promise.withResolvers<void>();

  /** 只阻塞首个 run.finished，其他事件立即追加。 */
  override async append(path: string, content: string): Promise<void> {
    if (content.includes('"type":"run.finished"')) {
      this.terminalStarted.resolve();
      await this.terminalGate.promise;
    }
    await super.append(path, content);
  }
}

interface Harness {
  readonly storage: MemorySessionStorage;
  readonly store: SessionStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly sessionEvents: SessionEventBus;
  readonly metadata: RunMetadataStore;
  readonly traces: RunTraceRegistry;
  readonly manager: SessionManager;
}

/** 构造全部使用内存 journal 的 SessionManager 测试环境。 */
function createHarness(
  runner: SessionRunExecutor,
  options: {
    readonly storage?: MemorySessionStorage;
    readonly environment?: Environment;
    readonly ids?: readonly string[];
    readonly newId?: () => string;
    readonly estimator?: SessionManagerOptions["estimator"];
    readonly shutdownTimeoutMs?: number;
    readonly order?: string[];
    readonly journalStorage?: MemoryJournalStorage;
  } = {},
): Harness {
  const storage = options.storage ?? new MemorySessionStorage();
  let clock = 0;
  const now = (): string => {
    clock += 1;
    return new Date(Date.UTC(2026, 8, 14, 8, 0, clock)).toISOString();
  };
  const store = new SessionStore(HOME, storage, now);
  const eventStore = new EventStore(HOME, options.journalStorage ?? new MemoryJournalStorage());
  const eventBus = new EventBus(eventStore, {
    onPersisted: (event) => options.order?.push(event.type),
  });
  const sessionEvents = new SessionEventBus(store, {
    onPersisted: (event) => options.order?.push(event.type),
  });
  const metadata = new RunMetadataStore(HOME, storage, now);
  const environment = options.environment ?? ENVIRONMENT;
  const traces = new RunTraceRegistry(HOME, environment);
  const ids = [...(options.ids ?? [TURN_A, RUN_A, TURN_B, RUN_B, TURN_C, RUN_C])];
  const manager = new SessionManager({
    store,
    runner,
    eventBus,
    eventStore,
    sessionEvents,
    metadata,
    traces,
    environment,
    now,
    newId: options.newId ?? (() => ids.shift() ?? crypto.randomUUID()),
    ...(options.estimator === undefined ? {} : { estimator: options.estimator }),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  return { storage, store, eventStore, eventBus, sessionEvents, metadata, traces, manager };
}

/** 解包测试中必须成功的结果，使断言保持聚焦。 */
function unwrapResult<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("expected successful result");
  return result.value;
}

/** 生成只包含当前 turn 消息的 provider-neutral completion。 */
function completionFor(
  request: AgentRunRequest,
  status: "succeeded" | "failed" | "cancelled" = "succeeded",
  reason: HistoryTurnReason = status === "succeeded"
    ? "completed"
    : status === "cancelled"
      ? "cancelled"
      : "llm_error",
): AgentRunOutcome {
  const messages: LlmMessage[] = [
    { role: "user", content: [{ type: "text", text: request.goal }] },
    { role: "assistant", content: [{ type: "text", text: `answer:${request.goal}` }] },
  ];
  return {
    completion: {
      status,
      reason,
      finalText: status === "succeeded" ? `answer:${request.goal}` : "",
      steps: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messages,
      model: "test-model",
    },
  };
}

/** 等待后台 run 完成 terminal commit。 */
async function waitForIdle(manager: SessionManager, timeoutMs = 1_000): Promise<void> {
  await waitFor(() => manager.activeCount === 0, timeoutMs);
}

/** 在短 deadline 内轮询异步状态机条件。 */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(1);
  }
}

describe("SessionManager accepted state machine", () => {
  test("rejects an over-budget message before allocating IDs or writing run files", async () => {
    const runner = new StubRunner(async (request) => completionFor(request));
    let idCalls = 0;
    const harness = createHarness(runner, {
      environment: {
        ...ENVIRONMENT,
        LLM_CONTEXT_WINDOW_TOKENS: "100",
        LLM_MAX_OUTPUT_TOKENS: "10",
      },
      estimator: () => 100,
      newId: () => {
        idCalls += 1;
        return crypto.randomUUID();
      },
    });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const filesBefore = new Map(harness.storage.files);
    const directoriesBefore = new Set(harness.storage.directories);

    const result = await harness.manager.prepareMessage({
      sessionId: session.sessionId,
      clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
      content: "too large",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "context_limit_exceeded" } });
    expect(idCalls).toBe(0);
    expect(runner.requests).toHaveLength(0);
    expect(harness.storage.files).toEqual(filesBefore);
    expect(harness.storage.directories).toEqual(directoriesBefore);
  });

  test("serializes concurrent submissions and safely deduplicates clientMessageId", async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new StubRunner(async (request) => {
      await blocked;
      return completionFor(request);
    });
    const { manager } = createHarness(runner);
    const session = unwrapResult(await manager.create("/workspace"));

    const [first, duplicate] = await Promise.all([
      manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
      manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    ]);
    expect(first.ok && duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) return;
    expect(duplicate.value.result).toEqual(first.value.result);
    expect(duplicate.value.idempotent).toBe(true);

    const conflict = await manager.prepareMessage({
      sessionId: session.sessionId,
      clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
      content: "different",
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "invalid_params" } });

    const busy = await manager.prepareMessage({
      sessionId: session.sessionId,
      clientMessageId: CLIENT_MESSAGE_B as ClientMessageId,
      content: "another message",
    });
    expect(busy).toMatchObject({ ok: false, error: { code: "session_busy" } });

    first.value.activate();
    duplicate.value.activate();
    await waitFor(() => runner.requests.length === 1);
    expect(runner.requests).toHaveLength(1);
    release();
    await waitForIdle(manager);

    const retryAfterFinish = unwrapResult(
      await manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    );
    expect(retryAfterFinish.result).toEqual(first.value.result);
    retryAfterFinish.activate();
    expect(runner.requests).toHaveLength(1);
  });

  test("keeps idempotent retries behind the original accepted response gate", async () => {
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner);
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const first = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    );
    const retry = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    );
    const recorder = harness.traces.get(session.sessionId, first.result.runId);

    retry.activate();
    await Bun.sleep(0);
    expect(runner.requests).toHaveLength(0);
    expect(unwrapResult(await harness.store.load(session.sessionId)).sessionEvents).toEqual([]);

    first.activate();
    await waitForIdle(harness.manager);
    expect(runner.requests).toHaveLength(1);
    expect(harness.traces.get(session.sessionId, first.result.runId)).toBe(recorder);

    // 后到的幂等重试即使先完成响应，也不能替代首次请求释放 Trace response 门闩。
    retry.recordResponseSent("retry-connection", "retry-request", true);
    expect(harness.traces.get(session.sessionId, first.result.runId)).toBe(recorder);
    first.recordResponseSent("original-connection", "original-request", true);
    expect(harness.traces.get(session.sessionId, first.result.runId)).toBeUndefined();
  });

  test("publishes accepted and terminal events only after response activation and history commit", async () => {
    const order: string[] = [];
    let eventBus: EventBus;
    const runner = new StubRunner(async (request) => {
      const started = await eventBus.publish({
        sessionId: request.sessionId,
        runId: request.runId,
        timestamp: new Date().toISOString(),
        durable: true,
        type: "run.started",
        payload: {},
      });
      if (!started.ok) throw new Error("failed to publish start");
      return completionFor(request);
    });
    const harness = createHarness(runner, { order });
    eventBus = harness.eventBus;
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    );
    expect(order).toEqual([]);

    order.push("response.enqueued");
    prepared.activate();
    await waitForIdle(harness.manager);

    expect(order).toEqual([
      "response.enqueued",
      "session.turn_accepted",
      "run.started",
      "run.finished",
      "session.turn_finished",
    ]);
    const history = unwrapResult(await harness.manager.getHistory(session.sessionId));
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]).toMatchObject({
      status: "succeeded",
      reason: "completed",
      includedInContext: true,
    });
    const metadata = unwrapResult(
      await harness.metadata.read(session.sessionId, prepared.result.runId),
    );
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      sessionId: session.sessionId,
      turnId: prepared.result.turnId,
      runId: prepared.result.runId,
      workspaceRoot: "/workspace",
      model: "test-model",
      status: "succeeded",
      reason: "completed",
    });
    expect(metadata?.acceptedAt).toBeDefined();
    expect(metadata?.startedAt).toBeDefined();
    expect(metadata?.finishedAt).toBeDefined();
  });

  test("does not let cancellation bypass the accepted response gate", async () => {
    const order: string[] = [];
    const runner = new StubRunner(async (request, signal) =>
      completionFor(request, signal.aborted ? "cancelled" : "succeeded"),
    );
    const harness = createHarness(runner, { order });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "cancel before response",
      }),
    );

    expect(await harness.manager.cancel(session.sessionId, prepared.result.runId)).toBe(
      "cancellation_requested",
    );
    await Bun.sleep(0);
    expect(order).toEqual([]);
    expect(runner.requests).toHaveLength(0);

    order.push("response.enqueued");
    prepared.activate();
    await waitForIdle(harness.manager);
    expect(order[0]).toBe("response.enqueued");
    expect(unwrapResult(await harness.manager.getHistory(session.sessionId)).turns[0]?.status).toBe(
      "cancelled",
    );
    expect(runner.requests).toHaveLength(0);
  });

  test("keeps cancellation authoritative when an active executor ignores AbortSignal", async () => {
    const release = Promise.withResolvers<void>();
    const runner = new StubRunner(async (request) => {
      await release.promise;
      return completionFor(request, "succeeded");
    });
    const harness = createHarness(runner);
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "ignore cancellation",
      }),
    );
    prepared.activate();
    await waitFor(() => runner.requests.length === 1);

    expect(await harness.manager.cancel(session.sessionId, prepared.result.runId)).toBe(
      "cancellation_requested",
    );
    release.resolve();
    await waitForIdle(harness.manager);
    expect(unwrapResult(await harness.manager.getHistory(session.sessionId)).turns[0]?.status).toBe(
      "cancelled",
    );
  });
});

describe("SessionManager multi-turn context and terminal ownership", () => {
  test("keeps one-shot sessions hidden and rejects follow-up messages", async () => {
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner, {
      ids: [CLIENT_MESSAGE_A, TURN_A, RUN_A],
    });

    const prepared = unwrapResult(await harness.manager.prepareOneShot("/workspace", "single"));
    expect(unwrapResult(await harness.manager.list({})).sessions).toHaveLength(0);
    expect(unwrapResult(await harness.manager.list({ includeOneShot: true })).sessions).toEqual([
      expect.objectContaining({ sessionId: prepared.result.sessionId, mode: "one_shot" }),
    ]);

    prepared.activate();
    await waitForIdle(harness.manager);
    const followUp = await harness.manager.prepareMessage({
      sessionId: prepared.result.sessionId,
      clientMessageId: CLIENT_MESSAGE_B as ClientMessageId,
      content: "again",
    });
    expect(followUp).toMatchObject({
      ok: false,
      error: { code: "one_shot_not_resumable" },
    });
  });

  test("includes only succeeded history and the latest notes in later turns", async () => {
    let store: SessionStore;
    let invocation = 0;
    const runner = new StubRunner(async (request) => {
      invocation += 1;
      if (invocation === 1) {
        const saved = await store
          .createNoteStore(request.sessionId, request.runId)
          .append("remember this");
        if (!saved.ok) throw new Error("failed to save note");
        return completionFor(request, "succeeded");
      }
      if (invocation === 2) {
        expect(request.history?.map((message) => message.content[0])).toEqual([
          { type: "text", text: "first" },
          { type: "text", text: "answer:first" },
        ]);
        expect(request.systemPrompt).toContain("remember this");
        return completionFor(request, "failed", "llm_error");
      }
      expect(request.history?.map((message) => message.content[0])).toEqual([
        { type: "text", text: "first" },
        { type: "text", text: "answer:first" },
      ]);
      expect(request.systemPrompt).toContain("remember this");
      return completionFor(request, "succeeded");
    });
    const harness = createHarness(runner);
    store = harness.store;
    const session = unwrapResult(await harness.manager.create("/workspace"));
    for (const [clientMessageId, content] of [
      [CLIENT_MESSAGE_A, "first"],
      [CLIENT_MESSAGE_B, "failed second"],
      [CLIENT_MESSAGE_C, "third"],
    ] as const) {
      const prepared = unwrapResult(
        await harness.manager.prepareMessage({
          sessionId: session.sessionId,
          clientMessageId: clientMessageId as ClientMessageId,
          content,
        }),
      );
      prepared.activate();
      await waitForIdle(harness.manager);
    }

    const history = unwrapResult(await harness.manager.getHistory(session.sessionId));
    expect(history.turns.map((turn) => [turn.status, turn.includedInContext])).toEqual([
      ["succeeded", true],
      ["failed", false],
      ["succeeded", true],
    ]);
  });

  test("isolates active runs across sessions and cancels only the exact identity", async () => {
    const runner = new StubRunner(
      async (request, signal) =>
        await new Promise<AgentRunOutcome>((resolve) => {
          signal.addEventListener("abort", () => resolve(completionFor(request, "cancelled")), {
            once: true,
          });
        }),
    );
    const harness = createHarness(runner, {
      ids: [TURN_A, RUN_A, TURN_B, RUN_B],
    });
    const firstSession = unwrapResult(await harness.manager.create("/workspace/a"));
    const secondSession = unwrapResult(await harness.manager.create("/workspace/b"));
    const first = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: firstSession.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "first",
      }),
    );
    const second = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: secondSession.sessionId,
        clientMessageId: CLIENT_MESSAGE_B as ClientMessageId,
        content: "second",
      }),
    );
    first.activate();
    second.activate();
    expect(harness.manager.activeCount).toBe(2);
    await waitFor(() => runner.requests.length === 2);

    expect(await harness.manager.cancel(firstSession.sessionId, RUN_B)).toBe("not_found");
    expect(await harness.manager.cancel(firstSession.sessionId, RUN_A)).toBe(
      "cancellation_requested",
    );
    await waitFor(() => harness.manager.activeCount === 1);
    expect(harness.manager.activeCount).toBe(1);
    expect(await harness.manager.cancel(firstSession.sessionId, RUN_A)).toBe("already_finished");
    expect(harness.manager.activeCount).toBe(1);

    expect(await harness.manager.cancel(secondSession.sessionId, RUN_B)).toBe(
      "cancellation_requested",
    );
    await waitForIdle(harness.manager);
    const firstHistory = unwrapResult(await harness.manager.getHistory(firstSession.sessionId));
    const secondHistory = unwrapResult(await harness.manager.getHistory(secondSession.sessionId));
    expect(firstHistory.turns[0]?.status).toBe("cancelled");
    expect(secondHistory.turns[0]?.status).toBe("cancelled");
  });

  test("bounds shutdown and force-commits one cancelled terminal for an unresponsive runner", async () => {
    const runner = new StubRunner(async () => await new Promise<AgentRunOutcome>(() => {}));
    const harness = createHarness(runner, { shutdownTimeoutMs: 10 });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hang",
      }),
    );
    prepared.activate();
    const startedAt = performance.now();
    await harness.manager.shutdown();
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(harness.manager.activeCount).toBe(0);

    const history = unwrapResult(await harness.manager.getHistory(session.sessionId));
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]?.status).toBe("cancelled");
    const journal = unwrapResult(
      await harness.eventStore.read(session.sessionId, prepared.result.runId),
    );
    expect(journal.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
  });

  test("accepts a response-gate release during shutdown and ignores later activation", async () => {
    const order: string[] = [];
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner, { order, shutdownTimeoutMs: 10 });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "late activation",
      }),
    );

    const shuttingDown = harness.manager.shutdown();
    prepared.activate();
    await shuttingDown;
    prepared.activate();

    expect(runner.requests).toHaveLength(0);
    expect(order).toEqual(["session.turn_accepted", "run.finished", "session.turn_finished"]);
    expect(unwrapResult(await harness.manager.get(session.sessionId)).status).not.toBe("corrupted");
    expect(unwrapResult(await harness.manager.getHistory(session.sessionId)).turns[0]?.status).toBe(
      "cancelled",
    );
  });

  test("finishes a one-shot admitted before shutdown without leaving an empty session", async () => {
    const storage = new BlockingOneShotCreateStorage();
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner, { storage, shutdownTimeoutMs: 10 });
    const preparing = harness.manager.prepareOneShot("/workspace", "racing one-shot");
    await storage.metaWriteStarted.promise;

    const shuttingDown = harness.manager.shutdown();
    storage.metaWriteGate.resolve();
    const prepared = unwrapResult(await preparing);
    // 模拟 Core 关闭 transport 时，响应已入队或连接 closed 对闸门的释放。
    prepared.activate();
    await shuttingDown;
    expect(harness.manager.activeCount).toBe(0);
    expect(runner.requests).toHaveLength(0);
    const history = unwrapResult(await harness.manager.getHistory(prepared.result.sessionId));
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]?.status).toBe("cancelled");
    expect(unwrapResult(await harness.store.load(prepared.result.sessionId)).sessionEvents).toEqual(
      [
        expect.objectContaining({ type: "session.turn_accepted" }),
        expect.objectContaining({ type: "session.turn_finished" }),
      ],
    );
  });

  test("waits for an admission that passed the stopping check before taking the active snapshot", async () => {
    const storage = new BlockingRunMetadataStorage();
    const runner = new StubRunner(async (request, signal) => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return completionFor(request, "cancelled");
    });
    const harness = createHarness(runner, { storage, shutdownTimeoutMs: 100 });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const preparing = harness.manager.prepareMessage({
      sessionId: session.sessionId,
      clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
      content: "racing admission",
    });
    await storage.writeStarted.promise;

    let shutdownFinished = false;
    const shuttingDown = harness.manager.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Bun.sleep(5);
    expect(shutdownFinished).toBe(false);

    storage.writeGate.resolve();
    const prepared = unwrapResult(await preparing);
    prepared.activate();
    await shuttingDown;
    expect(harness.manager.activeCount).toBe(0);
    expect(unwrapResult(await harness.manager.getHistory(session.sessionId)).turns[0]?.status).toBe(
      "cancelled",
    );
  });

  test("waits for terminal publication after activeRun has already been cleared", async () => {
    const journalStorage = new BlockingTerminalJournalStorage();
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner, { journalStorage, shutdownTimeoutMs: 100 });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "commit race",
      }),
    );
    prepared.activate();
    await journalStorage.terminalStarted.promise;
    expect(harness.manager.activeCount).toBe(0);

    let shutdownFinished = false;
    const shuttingDown = harness.manager.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Bun.sleep(5);
    expect(shutdownFinished).toBe(false);

    journalStorage.terminalGate.resolve();
    await shuttingDown;
    const journal = unwrapResult(
      await harness.eventStore.read(session.sessionId, prepared.result.runId),
    );
    expect(journal.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
  });

  test("marks a session corrupted when history completion persistence fails", async () => {
    const storage = new FailingCompletionStorage();
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner, { storage });
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const prepared = unwrapResult(
      await harness.manager.prepareMessage({
        sessionId: session.sessionId,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        content: "hello",
      }),
    );
    storage.failCompletion = true;
    prepared.activate();
    await waitForIdle(harness.manager);

    const summary = unwrapResult(await harness.manager.get(session.sessionId));
    expect(summary.status).toBe("corrupted");
    const journal = unwrapResult(
      await harness.eventStore.read(session.sessionId, prepared.result.runId),
    );
    const terminal = journal.events.find((event) => event.type === "run.finished");
    expect(terminal?.payload).toMatchObject({
      status: "failed",
      reason: "session_store_error",
      error: { code: "session_store_error", message: "run failed (session_store_error)" },
    });
    const snapshot = unwrapResult(await harness.store.load(session.sessionId));
    expect(snapshot.sessionEvents.some((event) => event.type === "session.turn_finished")).toBe(
      false,
    );
  });
});

describe("SessionManager restart reconciliation", () => {
  test("fails closed when the startup session scan cannot complete", async () => {
    const storage = new MemorySessionStorage();
    storage.listError = new Error("scan failed");
    const harness = createHarness(new StubRunner(async (request) => completionFor(request)), {
      storage,
    });
    await harness.manager.ready();

    expect(await harness.manager.create("/workspace")).toMatchObject({
      ok: false,
      error: { code: "internal_error", message: "session recovery did not complete" },
    });
    expect(await harness.manager.list({})).toMatchObject({
      ok: false,
      error: { code: "internal_error", message: "session recovery did not complete" },
    });
  });

  test("repairs an accepted turn without completion as interrupted/core_restarted", async () => {
    const runner = new StubRunner(async (request) => completionFor(request));
    const storage = new MemorySessionStorage();
    const store = new SessionStore(HOME, storage);
    const created = unwrapResult(await store.create({ workspaceRoot: "/workspace", mode: "chat" }));
    await store.appendAccepted(created.meta.sessionId, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
      userMessage: "unfinished",
    });
    const metadata = new RunMetadataStore(HOME, storage);
    await metadata.create({
      sessionId: created.meta.sessionId,
      turnId: TURN_A,
      runId: RUN_A,
      workspaceRoot: "/workspace",
      model: "test-model",
    });
    const eventStore = new EventStore(HOME, new MemoryJournalStorage());
    const eventBus = new EventBus(eventStore);
    const sessionEvents = new SessionEventBus(store);
    await sessionEvents.publish({
      sessionId: created.meta.sessionId,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "session.turn_accepted",
      payload: {
        turnId: TURN_A,
        runId: RUN_A,
        clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
        userMessage: "unfinished",
      },
    });
    const manager = new SessionManager({
      store,
      runner,
      eventBus,
      eventStore,
      sessionEvents,
      metadata,
      traces: new RunTraceRegistry(HOME, ENVIRONMENT),
      environment: ENVIRONMENT,
    });
    await manager.ready();

    const history = unwrapResult(await manager.getHistory(created.meta.sessionId));
    expect(history.turns[0]).toMatchObject({
      status: "interrupted",
      reason: "core_restarted",
      includedInContext: false,
    });
    const journal = unwrapResult(await eventStore.read(created.meta.sessionId, RUN_A));
    expect(journal.events.find((event) => event.type === "run.finished")?.payload).toMatchObject({
      status: "failed",
      reason: "core_restarted",
    });
    expect(history.session.status).toBe("idle");
    expect(history.throughSessionSequence).toBe(2);
  });

  test("repairs missing run/session terminals from completed history and rejects conflicts", async () => {
    const runner = new StubRunner(async (request) => completionFor(request));
    const harness = createHarness(runner);
    const session = unwrapResult(await harness.manager.create("/workspace"));
    const accepted = await harness.store.appendAccepted(session.sessionId, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A as ClientMessageId,
      userMessage: "done",
    });
    expect(accepted.ok).toBe(true);
    await harness.store.appendCompleted(session.sessionId, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "failed",
      reason: "llm_error",
      messages: [
        {
          messageId: "user",
          turnId: TURN_A,
          runId: RUN_A,
          role: "user",
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "done" }],
        },
      ],
      model: "test-model",
      runResult: {
        status: "failed",
        reason: "llm_error",
        finalText: "partial answer",
        steps: 3,
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
        error: { code: "llm_error", message: "run failed (llm_error)" },
      },
    });
    await harness.metadata.create({
      sessionId: session.sessionId,
      turnId: TURN_A,
      runId: RUN_A,
      workspaceRoot: "/workspace",
      model: "test-model",
    });
    const recovering = new SessionManager({
      store: harness.store,
      runner,
      eventBus: harness.eventBus,
      eventStore: harness.eventStore,
      sessionEvents: harness.sessionEvents,
      metadata: harness.metadata,
      traces: harness.traces,
      environment: ENVIRONMENT,
    });
    await recovering.ready();
    const repaired = unwrapResult(await recovering.getHistory(session.sessionId));
    expect(repaired.throughSessionSequence).toBe(2);
    const repairedJournal = unwrapResult(await harness.eventStore.read(session.sessionId, RUN_A));
    expect(repairedJournal.events.find((event) => event.type === "run.finished")?.payload).toEqual({
      status: "failed",
      reason: "llm_error",
      finalText: "partial answer",
      steps: 3,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
      error: { code: "llm_error", message: "run failed (llm_error)" },
    });

    const conflictStorage = new MemorySessionStorage();
    const conflictStore = new SessionStore("/conflict", conflictStorage);
    const conflictSession = unwrapResult(
      await conflictStore.create({ workspaceRoot: "/workspace", mode: "chat" }),
    );
    await conflictStore.appendAccepted(conflictSession.meta.sessionId, {
      turnId: TURN_B,
      runId: RUN_B,
      clientMessageId: CLIENT_MESSAGE_B as ClientMessageId,
      userMessage: "conflict",
    });
    await conflictStore.appendCompleted(conflictSession.meta.sessionId, {
      turnId: TURN_B,
      runId: RUN_B,
      status: "succeeded",
      reason: "completed",
      messages: [],
      model: "test-model",
    });
    const conflictJournal = new MemoryJournalStorage();
    const conflictEventStore = new EventStore("/conflict", conflictJournal);
    const conflictBus = new EventBus(conflictEventStore);
    await conflictBus.publish({
      sessionId: conflictSession.meta.sessionId,
      runId: RUN_B,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "run.finished",
      payload: {
        status: "succeeded",
        reason: "completed",
        finalText: "",
        steps: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    await conflictJournal.append(
      conflictEventStore.pathFor(conflictSession.meta.sessionId, RUN_B),
      `${JSON.stringify({
        sessionId: conflictSession.meta.sessionId,
        runId: RUN_B,
        sequence: 2,
        timestamp: new Date().toISOString(),
        durable: true,
        type: "run.finished",
        payload: {
          status: "failed",
          reason: "llm_error",
          finalText: "",
          steps: 0,
          usage: EMPTY_USAGE,
        },
      })}\n`,
    );
    const conflictManager = new SessionManager({
      store: conflictStore,
      runner,
      eventBus: conflictBus,
      eventStore: conflictEventStore,
      sessionEvents: new SessionEventBus(conflictStore),
      metadata: new RunMetadataStore("/conflict", conflictStorage),
      traces: new RunTraceRegistry("/conflict", ENVIRONMENT),
      environment: ENVIRONMENT,
    });
    await conflictManager.ready();
    expect(unwrapResult(await conflictManager.get(conflictSession.meta.sessionId)).status).toBe(
      "corrupted",
    );
  });
});
