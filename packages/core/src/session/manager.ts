import type {
  AgentCancelResult,
  AgentEvent,
  ClientMessageId,
  Environment,
  HistoryMessage,
  HistoryTurn,
  HistoryTurnReason,
  RunId,
  SessionGetHistoryResult,
  SessionListResult,
  SessionMode,
  SessionSendMessageResult,
  SessionSummary,
  TurnId,
} from "@minicode/protocol";
import type { EventBus } from "../events/event-bus.ts";
import type { SessionEventBus } from "../events/session-event-bus.ts";
import type { EventStore } from "../events/event-store.ts";
import type { LlmMessage, LlmUsage } from "../llm/types.ts";
import type { AgentRunOutcome, AgentRunRequest } from "../run/runner.ts";
import { buildRunSystemPrompt, runToolSchemas } from "../run/runner.ts";
import type { RunCompletion } from "../run/completion.ts";
import { toHistoryMessages } from "../run/completion.ts";
import type { RunMetadataStore } from "../run/metadata.ts";
import type { RunTraceRegistry } from "../trace/registry.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import {
  checkContextBudget,
  type ContextBudgetEstimator,
  defaultContextBudgetEstimator,
  loadContextBudgetConfig,
} from "./context-budget.ts";
import { buildContextMessages, type SessionStore } from "./session-store.ts";
import type { SessionSnapshot } from "./types.ts";

const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const LLM_MODEL_ENV_KEY = "LLM_MODEL";

/** daemon shutdown 等待正常取消与终态提交的默认上限。 */
export const DEFAULT_SESSION_SHUTDOWN_TIMEOUT_MS = 5_000;

/** SessionManager 对 Runner 的最小依赖，便于隔离编排测试与替换 provider 实现。 */
export interface SessionRunExecutor {
  run(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunOutcome>;
}

export type SessionManagerFailureCode =
  | "session_not_found"
  | "session_busy"
  | "session_corrupted"
  | "context_limit_exceeded"
  | "one_shot_not_resumable"
  | "invalid_params"
  | "internal_error";

export interface SessionManagerFailure {
  readonly code: SessionManagerFailureCode;
  readonly message: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runId?: string;
}

export type SessionManagerResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SessionManagerFailure };

export interface PreparedSessionRun {
  readonly result: SessionSendMessageResult;
  readonly idempotent: boolean;
  /** 记录已经通过校验并成功归属到 run 的请求。 */
  recordRequest(connectionId: string, requestId: string, method: string, params: unknown): void;
  /** 响应入连接写队列后启动共享 run；可重复调用。 */
  activate(): void;
  /** 响应真正交给 socket 后记录 sent 或安全错误。 */
  recordResponseSent(connectionId: string, requestId: string, sent: boolean): void;
}

interface ActiveExecution {
  readonly sessionId: string;
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly clientMessageId: ClientMessageId;
  readonly userMessage: string;
  readonly workspaceRoot: string;
  readonly history: readonly LlmMessage[];
  readonly systemPrompt: string;
  readonly trace: TraceRecorder;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  activated: boolean;
  acceptedPublished: boolean;
  commit: Promise<void> | undefined;
}

export interface SessionManagerOptions {
  readonly store: SessionStore;
  readonly runner: SessionRunExecutor;
  readonly eventBus: EventBus;
  readonly eventStore: EventStore;
  readonly sessionEvents: SessionEventBus;
  readonly metadata: RunMetadataStore;
  readonly traces: RunTraceRegistry;
  readonly environment: Environment;
  readonly estimator?: ContextBudgetEstimator;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly shutdownTimeoutMs?: number;
}

/**
 * 多轮会话的唯一编排者：串行 accepted 临界区、管理 session 级执行权，
 * 并按 history → run.finished → session.turn_finished 的顺序提交终态。
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #runner: SessionRunExecutor;
  readonly #eventBus: EventBus;
  readonly #eventStore: EventStore;
  readonly #sessionEvents: SessionEventBus;
  readonly #metadata: RunMetadataStore;
  readonly #traces: RunTraceRegistry;
  readonly #environment: Environment;
  readonly #estimator: ContextBudgetEstimator;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #shutdownTimeoutMs: number;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #active = new Map<string, ActiveExecution>();
  readonly #busySessions = new Set<string>();
  readonly #finishedRuns = new Set<string>();
  readonly #corruptedSessions = new Set<string>();
  readonly #ready: Promise<void>;
  #stopping = false;

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#eventBus = options.eventBus;
    this.#eventStore = options.eventStore;
    this.#sessionEvents = options.sessionEvents;
    this.#metadata = options.metadata;
    this.#traces = options.traces;
    this.#environment = options.environment;
    this.#estimator = options.estimator ?? defaultContextBudgetEstimator;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SESSION_SHUTDOWN_TIMEOUT_MS;
    this.#ready = this.#recoverAll();
  }

  /** 等待启动恢复完成；恢复单个坏 session 不阻止其他 session 使用。 */
  async ready(): Promise<void> {
    await this.#ready;
  }

  /** 创建固定 workspace 的 chat 或 one_shot session。 */
  async create(
    workspaceRoot: string,
    mode: SessionMode = "chat",
  ): Promise<SessionManagerResult<SessionSummary>> {
    await this.#ready;
    if (this.#stopping) {
      return this.#internal("core is shutting down");
    }
    const created = await this.#store.create({ workspaceRoot, mode });
    if (!created.ok) {
      return this.#fromStore(created.error.code);
    }
    return { ok: true, value: this.#summary(created.value) };
  }

  /** 读取 session 摘要，并叠加运行期 corrupted 标记。 */
  async get(sessionId: string): Promise<SessionManagerResult<SessionSummary>> {
    await this.#ready;
    const loaded = await this.#store.load(sessionId);
    if (!loaded.ok) {
      return this.#fromStore(loaded.error.code, sessionId);
    }
    const summary = this.#summary(loaded.value);
    return {
      ok: true,
      value: this.#corruptedSessions.has(sessionId)
        ? { ...summary, status: "corrupted", activeRun: undefined }
        : summary,
    };
  }

  /** 按 store 的稳定 cursor 规则列出 session。 */
  async list(options: {
    readonly workspaceRoot?: string;
    readonly includeOneShot?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<SessionManagerResult<SessionListResult>> {
    await this.#ready;
    const listed = await this.#store.list(options);
    if (!listed.ok) {
      return this.#fromStore(listed.error.code);
    }
    return {
      ok: true,
      value: {
        sessions: listed.value.sessions.map((session) =>
          this.#corruptedSessions.has(session.sessionId)
            ? { ...session, status: "corrupted" as const, activeRun: undefined }
            : session,
        ),
        ...(listed.value.nextCursor === undefined ? {} : { nextCursor: listed.value.nextCursor }),
      },
    };
  }

  /** 返回 provider-neutral 审计历史和同一时刻的 session sequence 水位。 */
  async getHistory(sessionId: string): Promise<SessionManagerResult<SessionGetHistoryResult>> {
    await this.#ready;
    const loaded = await this.#store.load(sessionId);
    if (!loaded.ok) {
      return this.#fromStore(loaded.error.code, sessionId);
    }
    return {
      ok: true,
      value: {
        session: this.#corruptedSessions.has(sessionId)
          ? { ...this.#summary(loaded.value), status: "corrupted", activeRun: undefined }
          : this.#summary(loaded.value),
        turns: [...loaded.value.turns],
        throughSessionSequence: loaded.value.latestSessionSequence,
      },
    };
  }

  /** 为 chat session 做 accepted 前检查并准备一个延迟激活的 run。 */
  async prepareMessage(input: {
    readonly sessionId: string;
    readonly clientMessageId: ClientMessageId;
    readonly content: string;
  }): Promise<SessionManagerResult<PreparedSessionRun>> {
    await this.#ready;
    return this.#withSessionLock(input.sessionId, async () => {
      if (this.#stopping) {
        return this.#internal("core is shutting down");
      }
      const loaded = await this.#store.load(input.sessionId);
      if (!loaded.ok) {
        return this.#fromStore(loaded.error.code, input.sessionId);
      }
      if (this.#corruptedSessions.has(input.sessionId)) {
        return this.#failure("session_corrupted", "session is corrupted", input.sessionId);
      }
      if (loaded.value.meta.mode === "one_shot") {
        return this.#failure(
          "one_shot_not_resumable",
          "one-shot session cannot accept another message",
          input.sessionId,
        );
      }
      return this.#prepareFromSnapshot(loaded.value, input.clientMessageId, input.content);
    });
  }

  /** 创建 one_shot session，并用与 chat 相同的持久化/预算/执行管线准备首轮。 */
  async prepareOneShot(
    workspaceRoot: string,
    content: string,
  ): Promise<SessionManagerResult<PreparedSessionRun>> {
    const created = await this.create(workspaceRoot, "one_shot");
    if (!created.ok) {
      return created;
    }
    const sessionId = created.value.sessionId;
    return this.#withSessionLock(sessionId, async () => {
      const loaded = await this.#store.load(sessionId);
      if (!loaded.ok) {
        return this.#fromStore(loaded.error.code, sessionId);
      }
      return this.#prepareFromSnapshot(loaded.value, this.#newId() as ClientMessageId, content);
    });
  }

  /** 精确取消共享 active run；连接身份不参与执行权判断。 */
  async cancel(sessionId: string, runId: string): Promise<AgentCancelResult["outcome"]> {
    await this.#ready;
    const active = this.#active.get(this.#runKey(sessionId, runId));
    if (active !== undefined) {
      this.#activate(active);
      active.controller.abort();
      return "cancellation_requested";
    }
    return this.#finishedRuns.has(this.#runKey(sessionId, runId))
      ? "already_finished"
      : "not_found";
  }

  /** 拒绝新消息，取消并等待所有 active run 完成确定的 terminal commit。 */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    await this.#ready;
    const active = [...this.#active.values()];
    for (const execution of active) {
      this.#activate(execution);
      execution.controller.abort();
    }
    await this.#waitBounded(active.map((execution) => execution.settled));
    const unfinished = active.filter((execution) =>
      this.#active.has(this.#runKey(execution.sessionId, execution.runId)),
    );
    await this.#waitBounded(
      unfinished.map((execution) =>
        this.#commitOnce(execution, {
          completion: this.#cancelledCompletion(execution.userMessage),
        }),
      ),
    );
    await this.#traces.stopAll();
  }

  /** 当前尚未释放 session 执行权的 run 数量。 */
  get activeCount(): number {
    return this.#active.size;
  }

  /** 在锁内执行幂等检查、busy 检查、preflight、持久化 accepted 和 active 登记。 */
  async #prepareFromSnapshot(
    snapshot: SessionSnapshot,
    clientMessageId: ClientMessageId,
    content: string,
  ): Promise<SessionManagerResult<PreparedSessionRun>> {
    const existing = snapshot.turns.find((turn) => turn.clientMessageId === clientMessageId);
    if (existing !== undefined) {
      const original = this.#userMessage(existing);
      if (original !== content) {
        return this.#failure(
          "invalid_params",
          "clientMessageId content conflict",
          snapshot.meta.sessionId,
        );
      }
      const active = this.#active.get(this.#runKey(snapshot.meta.sessionId, existing.runId));
      return {
        ok: true,
        value: this.#preparedResult(
          snapshot.meta.sessionId,
          existing.turnId,
          existing.runId,
          true,
          active,
        ),
      };
    }

    if (
      this.#busySessions.has(snapshot.meta.sessionId) ||
      snapshot.activeRun !== undefined ||
      snapshot.status === "running"
    ) {
      return this.#failure(
        "session_busy",
        "session already has an active run",
        snapshot.meta.sessionId,
      );
    }

    const history = buildContextMessages(snapshot.turns);
    const systemPrompt = buildRunSystemPrompt(snapshot.notes);
    const baseSystemPrompt = buildRunSystemPrompt("");
    const budgetConfig = loadContextBudgetConfig(this.#environment);
    if (!budgetConfig.ok) {
      return this.#internal("context budget configuration is invalid");
    }
    const budget = checkContextBudget(
      budgetConfig.value,
      {
        systemPrompt: baseSystemPrompt,
        notes: snapshot.notes,
        messages: history,
        userMessage: content,
        toolSchemas: runToolSchemas(),
      },
      this.#estimator,
    );
    if (!budget.ok) {
      return this.#failure(
        "context_limit_exceeded",
        "session context exceeds the configured budget",
        snapshot.meta.sessionId,
      );
    }

    // ID 分配严格晚于 context preflight。
    const turnId = this.#newId() as TurnId;
    const runId = this.#newId() as RunId;
    const acceptedAt = this.#now();
    const metadata = await this.#metadata.create({
      sessionId: snapshot.meta.sessionId,
      turnId,
      runId,
      workspaceRoot: snapshot.meta.workspaceRoot,
      model: this.#environment[LLM_MODEL_ENV_KEY] ?? "",
      acceptedAt,
    });
    if (!metadata.ok) {
      return this.#internal("failed to persist run metadata");
    }

    const accepted = await this.#store.appendAccepted(snapshot.meta.sessionId, {
      turnId,
      runId,
      clientMessageId,
      userMessage: content,
    });
    if (!accepted.ok) {
      return this.#fromStore(accepted.error.code, snapshot.meta.sessionId);
    }

    const deferred = Promise.withResolvers<void>();
    const execution: ActiveExecution = {
      sessionId: snapshot.meta.sessionId,
      turnId,
      runId,
      clientMessageId,
      userMessage: content,
      workspaceRoot: snapshot.meta.workspaceRoot,
      history,
      systemPrompt,
      trace: this.#traces.create(snapshot.meta.sessionId, runId),
      controller: new AbortController(),
      settled: deferred.promise,
      resolveSettled: deferred.resolve,
      activated: false,
      acceptedPublished: false,
      commit: undefined,
    };
    this.#active.set(this.#runKey(snapshot.meta.sessionId, runId), execution);
    this.#busySessions.add(snapshot.meta.sessionId);
    return {
      ok: true,
      value: this.#preparedResult(snapshot.meta.sessionId, turnId, runId, false, execution),
    };
  }

  /** 构造带幂等激活与 Trace 回调的 accepted 结果。 */
  #preparedResult(
    sessionId: string,
    turnId: TurnId,
    runId: RunId,
    idempotent: boolean,
    active?: ActiveExecution,
  ): PreparedSessionRun {
    const trace = active?.trace ?? this.#traces.get(sessionId, runId);
    let requestIdentity:
      | { readonly connectionId: string; readonly requestId: string; readonly method: string }
      | undefined;
    let responseQueuedRecorded = false;
    return {
      result: { status: "accepted", sessionId, turnId, runId },
      idempotent,
      recordRequest(connectionId, requestId, method, params) {
        requestIdentity = { connectionId, requestId, method };
        trace?.record({
          source: "CLIENT",
          target: "CORE",
          kind: "ipc.request_received",
          connectionId,
          requestId,
          data: { method, params },
        });
      },
      activate: () => {
        if (!responseQueuedRecorded) {
          responseQueuedRecorded = true;
          trace?.record({
            source: "CORE",
            target: "CLIENT",
            kind: "ipc.response_queued",
            ...(requestIdentity === undefined
              ? {}
              : {
                  connectionId: requestIdentity.connectionId,
                  requestId: requestIdentity.requestId,
                }),
            data: {
              method: requestIdentity?.method ?? "unknown",
              status: "accepted",
            },
          });
        }
        if (active !== undefined) {
          this.#activate(active);
        }
      },
      recordResponseSent(connectionId, requestId, sent) {
        trace?.record({
          source: "CORE",
          target: "CLIENT",
          kind: sent ? "ipc.response_sent" : "ipc.error",
          connectionId,
          requestId,
          data: { status: sent ? "sent" : "connection_closed" },
        });
      },
    };
  }

  /** 幂等激活 prepared run；后台异常被收敛后仍完成 settled。 */
  #activate(execution: ActiveExecution): void {
    if (execution.activated) {
      return;
    }
    execution.activated = true;
    void this.#execute(execution).finally(execution.resolveSettled);
  }

  /** 发布 accepted session event、运行 AgentRunner，并提交唯一终态。 */
  async #execute(execution: ActiveExecution): Promise<void> {
    let outcome: AgentRunOutcome;
    try {
      const metadata = await this.#metadata.markStarted(execution.sessionId, execution.runId);
      const acceptedEvent = await this.#publishAccepted(execution);
      if (!metadata.ok || !acceptedEvent) {
        this.#corruptedSessions.add(execution.sessionId);
        outcome = {
          completion: this.#failedCompletion(execution.userMessage, "session_store_error"),
        };
      } else {
        const request: AgentRunRequest = {
          sessionId: execution.sessionId,
          runId: execution.runId,
          goal: execution.userMessage,
          workspaceRoot: execution.workspaceRoot,
          history: execution.history,
          systemPrompt: execution.systemPrompt,
          trace: execution.trace,
        };
        outcome = await this.#runner.run(request, execution.controller.signal);
      }
    } catch {
      outcome = {
        completion: this.#failedCompletion(execution.userMessage, "internal_error"),
      };
    }
    await this.#commitOnce(execution, outcome);
  }

  /** 持久化并广播权威 turn_accepted；失败时不启动 provider。 */
  async #publishAccepted(execution: ActiveExecution): Promise<boolean> {
    const published = await this.#sessionEvents.publish({
      sessionId: execution.sessionId,
      timestamp: this.#now(),
      durable: true,
      type: "session.turn_accepted",
      payload: {
        turnId: execution.turnId,
        runId: execution.runId,
        clientMessageId: execution.clientMessageId,
        userMessage: execution.userMessage,
      },
    });
    execution.acceptedPublished = published.ok;
    return published.ok;
  }

  /** 保证正常返回、取消、shutdown 超时与异常路径只能进入同一个终态提交。 */
  #commitOnce(execution: ActiveExecution, outcome: AgentRunOutcome): Promise<void> {
    if (execution.commit !== undefined) {
      return execution.commit;
    }
    execution.commit = this.#commit(execution, outcome);
    return execution.commit;
  }

  /** 严格按 history、active、run event、session event 的顺序提交 completion。 */
  async #commit(execution: ActiveExecution, outcome: AgentRunOutcome): Promise<void> {
    let completion = outcome.completion;
    const messages = toHistoryMessages(
      completion.messages,
      execution.turnId,
      execution.runId,
      this.#now,
    );
    const persisted = await this.#store.appendCompleted(execution.sessionId, {
      turnId: execution.turnId,
      runId: execution.runId,
      status: completion.status,
      reason: completion.reason,
      messages,
      model: completion.model,
      ...(completion.taskGraph === undefined ? {} : { taskGraph: completion.taskGraph }),
    });
    if (!persisted.ok) {
      this.#corruptedSessions.add(execution.sessionId);
      completion = this.#failedCompletion(execution.userMessage, "session_store_error");
    }

    // history 已提交（或明确失败）后才清除对外 activeRun；执行权保持到事件收尾。
    const runKey = this.#runKey(execution.sessionId, execution.runId);
    this.#finishedRuns.add(runKey);
    this.#active.delete(runKey);
    const metadata = await this.#metadata.markFinished(
      execution.sessionId,
      execution.runId,
      completion.status,
      completion.reason,
    );
    if (!metadata.ok) {
      this.#corruptedSessions.add(execution.sessionId);
    }

    const finished = await this.#eventBus.publish({
      sessionId: execution.sessionId,
      runId: execution.runId,
      timestamp: this.#now(),
      durable: true,
      type: "run.finished",
      payload: this.#runFinishedPayload(completion),
    });
    if (!finished.ok) {
      this.#corruptedSessions.add(execution.sessionId);
    }

    if (persisted.ok && finished.ok && execution.acceptedPublished) {
      const sessionFinished = await this.#sessionEvents.publish({
        sessionId: execution.sessionId,
        timestamp: this.#now(),
        durable: true,
        type: "session.turn_finished",
        payload: {
          turnId: execution.turnId,
          runId: execution.runId,
          status: completion.status,
          reason: completion.reason,
        },
      });
      if (!sessionFinished.ok) {
        this.#corruptedSessions.add(execution.sessionId);
      }
    }
    this.#busySessions.delete(execution.sessionId);
    await this.#traces.stop(execution.sessionId, execution.runId);
  }

  /** daemon 启动时逐 session 对齐 history、run event 与 session event。 */
  async #recoverAll(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#store.list({
        includeOneShot: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok) {
        return;
      }
      for (const summary of page.value.sessions) {
        const loaded = await this.#store.load(summary.sessionId);
        if (!loaded.ok) {
          if (loaded.error.code === "session_corrupted") {
            this.#corruptedSessions.add(summary.sessionId);
          }
          continue;
        }
        await this.#recoverSession(loaded.value);
      }
      cursor = page.value.nextCursor;
    } while (cursor !== undefined);
  }

  /** 恢复一个合法 session 的缺失终态，冲突时只标记该 session corrupted。 */
  async #recoverSession(snapshot: SessionSnapshot): Promise<void> {
    if (!this.#sessionJournalMatchesHistory(snapshot)) {
      this.#corruptedSessions.add(snapshot.meta.sessionId);
      return;
    }
    for (const turn of snapshot.turns) {
      const journal = await this.#eventStore.read(snapshot.meta.sessionId, turn.runId);
      if (!journal.ok) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }
      const terminal = journal.value.events.find((event) => event.type === "run.finished");
      const existingSessionFinished = snapshot.sessionEvents.find(
        (event) => event.type === "session.turn_finished" && event.payload.turnId === turn.turnId,
      );
      if (existingSessionFinished !== undefined && terminal === undefined) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }
      let recoveredTurn = turn;
      if (turn.status === "running") {
        if (
          terminal !== undefined &&
          (terminal.payload.status !== "failed" || terminal.payload.reason !== "core_restarted")
        ) {
          this.#corruptedSessions.add(snapshot.meta.sessionId);
          return;
        }
        const metadata = await this.#metadata.read(snapshot.meta.sessionId, turn.runId);
        const appended = await this.#store.appendCompleted(snapshot.meta.sessionId, {
          turnId: turn.turnId,
          runId: turn.runId,
          status: "interrupted",
          reason: "core_restarted",
          messages: turn.messages,
          model: metadata.ok ? (metadata.value?.model ?? "") : "",
        });
        if (!appended.ok) {
          this.#corruptedSessions.add(snapshot.meta.sessionId);
          return;
        }
        recoveredTurn = {
          ...turn,
          status: "interrupted",
          reason: "core_restarted",
          includedInContext: false,
        };
      } else if (terminal !== undefined && !this.#terminalMatches(turn, terminal)) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }

      const acceptedEvent = snapshot.sessionEvents.find(
        (event) => event.type === "session.turn_accepted" && event.payload.turnId === turn.turnId,
      );
      if (acceptedEvent === undefined) {
        const userMessage = this.#userMessage(turn);
        const published = await this.#sessionEvents.publish({
          sessionId: snapshot.meta.sessionId,
          timestamp: this.#now(),
          durable: true,
          type: "session.turn_accepted",
          payload: {
            turnId: turn.turnId,
            runId: turn.runId,
            clientMessageId: turn.clientMessageId,
            userMessage,
          },
        });
        if (!published.ok) {
          this.#corruptedSessions.add(snapshot.meta.sessionId);
          return;
        }
      }

      if (terminal === undefined) {
        const payload = this.#payloadFromHistory(recoveredTurn);
        const published = await this.#eventBus.publish({
          sessionId: snapshot.meta.sessionId,
          runId: turn.runId,
          timestamp: this.#now(),
          durable: true,
          type: "run.finished",
          payload,
        });
        if (!published.ok) {
          this.#corruptedSessions.add(snapshot.meta.sessionId);
          return;
        }
      }
      this.#finishedRuns.add(this.#runKey(snapshot.meta.sessionId, turn.runId));

      const finishedEvent = snapshot.sessionEvents.find(
        (event) => event.type === "session.turn_finished" && event.payload.turnId === turn.turnId,
      );
      if (finishedEvent === undefined) {
        const reason = this.#historyReason(recoveredTurn);
        const published = await this.#sessionEvents.publish({
          sessionId: snapshot.meta.sessionId,
          timestamp: this.#now(),
          durable: true,
          type: "session.turn_finished",
          payload: {
            turnId: turn.turnId,
            runId: turn.runId,
            status: recoveredTurn.status === "running" ? "interrupted" : recoveredTurn.status,
            reason,
          },
        });
        if (!published.ok) {
          this.#corruptedSessions.add(snapshot.meta.sessionId);
          return;
        }
      }
      const metadata = await this.#metadata.markFinished(
        snapshot.meta.sessionId,
        turn.runId,
        recoveredTurn.status === "running" ? "interrupted" : recoveredTurn.status,
        this.#historyReason(recoveredTurn),
      );
      if (!metadata.ok) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }
    }
  }

  /** 校验 session journal 只引用现有 turn，且 accepted/finished 身份、内容、顺序与 history 一致。 */
  #sessionJournalMatchesHistory(snapshot: SessionSnapshot): boolean {
    const turns = new Map(snapshot.turns.map((turn) => [turn.turnId, turn]));
    const acceptedSequence = new Map<string, number>();
    const finishedSequence = new Map<string, number>();
    for (const event of snapshot.sessionEvents) {
      const turn = turns.get(event.payload.turnId);
      if (turn === undefined || event.payload.runId !== turn.runId) {
        return false;
      }
      if (event.type === "session.turn_accepted") {
        if (
          acceptedSequence.has(turn.turnId) ||
          event.payload.clientMessageId !== turn.clientMessageId ||
          event.payload.userMessage !== this.#userMessage(turn)
        ) {
          return false;
        }
        acceptedSequence.set(turn.turnId, event.sessionSequence);
        continue;
      }
      if (
        finishedSequence.has(turn.turnId) ||
        turn.status === "running" ||
        event.payload.status !== turn.status ||
        event.payload.reason !== this.#historyReason(turn)
      ) {
        return false;
      }
      finishedSequence.set(turn.turnId, event.sessionSequence);
    }
    for (const [turnId, sequence] of finishedSequence) {
      const accepted = acceptedSequence.get(turnId);
      if (accepted === undefined || accepted >= sequence) {
        return false;
      }
    }
    return true;
  }

  /** 由 SessionSnapshot 构造协议摘要。 */
  #summary(snapshot: SessionSnapshot): SessionSummary {
    return {
      sessionId: snapshot.meta.sessionId,
      mode: snapshot.meta.mode,
      status: snapshot.status,
      title: snapshot.meta.title,
      workspaceRoot: snapshot.meta.workspaceRoot,
      createdAt: snapshot.meta.createdAt,
      updatedAt: snapshot.updatedAt,
      latestSessionSequence: snapshot.latestSessionSequence,
      ...(snapshot.activeRun === undefined ? {} : { activeRun: snapshot.activeRun }),
    };
  }

  /** 从历史 turn 中提取权威用户原文。 */
  #userMessage(turn: HistoryTurn): string {
    for (const message of turn.messages) {
      if (message.role !== "user") continue;
      const text = message.content.find((part) => part.type === "text");
      if (text?.type === "text") return text.text;
    }
    return "";
  }

  /** 组装尚未调用 provider 时的安全失败 completion。 */
  #failedCompletion(userMessage: string, reason: HistoryTurnReason): RunCompletion {
    return {
      status: "failed",
      reason,
      finalText: "",
      steps: 0,
      usage: EMPTY_USAGE,
      messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      model: this.#environment[LLM_MODEL_ENV_KEY] ?? "",
      error: { code: reason, message: `run failed (${reason})` },
    };
  }

  /** shutdown 超时强制收尾时构造不包含旧历史的 cancelled completion。 */
  #cancelledCompletion(userMessage: string): RunCompletion {
    return {
      status: "cancelled",
      reason: "cancelled",
      finalText: "",
      steps: 0,
      usage: EMPTY_USAGE,
      messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      model: this.#environment[LLM_MODEL_ENV_KEY] ?? "",
    };
  }

  /** 在固定 deadline 内等待一组后台工作，防止 shutdown 被不响应 abort 的 provider 卡死。 */
  async #waitBounded(promises: readonly Promise<unknown>[]): Promise<void> {
    if (promises.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#shutdownTimeoutMs);
    });
    await Promise.race([Promise.allSettled(promises).then(() => undefined), timeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  /** 将内部 completion 转成严格的 run.finished payload。 */
  #runFinishedPayload(
    completion: RunCompletion,
  ): Extract<AgentEvent, { type: "run.finished" }>["payload"] {
    if (completion.status === "succeeded") {
      return { ...this.#resultFields(completion), status: "succeeded", reason: "completed" };
    }
    if (completion.status === "cancelled") {
      return { ...this.#resultFields(completion), status: "cancelled", reason: "cancelled" };
    }
    return {
      ...this.#resultFields(completion),
      status: "failed",
      reason:
        completion.reason === "completed" || completion.reason === "cancelled"
          ? "internal_error"
          : completion.reason,
      ...(completion.error === undefined ? {} : { error: completion.error }),
    };
  }

  /** 提取 run.finished 三个公共结果字段。 */
  #resultFields(completion: RunCompletion): { finalText: string; steps: number; usage: LlmUsage } {
    return { finalText: completion.finalText, steps: completion.steps, usage: completion.usage };
  }

  /** 由 history 恢复可重放的 run.finished payload。 */
  #payloadFromHistory(turn: HistoryTurn): Extract<AgentEvent, { type: "run.finished" }>["payload"] {
    const finalText = this.#finalText(turn.messages);
    if (turn.status === "succeeded") {
      return { status: "succeeded", reason: "completed", finalText, steps: 0, usage: EMPTY_USAGE };
    }
    if (turn.status === "cancelled") {
      return { status: "cancelled", reason: "cancelled", finalText, steps: 0, usage: EMPTY_USAGE };
    }
    return {
      status: "failed",
      reason:
        turn.reason === "completed" || turn.reason === "cancelled" || turn.reason === undefined
          ? "core_restarted"
          : turn.reason,
      finalText,
      steps: 0,
      usage: EMPTY_USAGE,
    };
  }

  /** 从审计消息中提取最后一段 Assistant 文本。 */
  #finalText(messages: readonly HistoryMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      return message.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
    }
    return "";
  }

  /** 把 run.finished 映射到 history 的终态枚举。 */
  #historyStatus(
    event: Extract<AgentEvent, { type: "run.finished" }>,
  ): Exclude<HistoryTurn["status"], "running"> {
    return event.payload.reason === "core_restarted" ? "interrupted" : event.payload.status;
  }

  /** 为旧记录缺省 reason 推导唯一规范值，供恢复冲突检查和补事件使用。 */
  #historyReason(turn: HistoryTurn): HistoryTurnReason {
    if (turn.reason !== undefined) {
      return turn.reason;
    }
    if (turn.status === "succeeded") {
      return "completed";
    }
    if (turn.status === "cancelled") {
      return "cancelled";
    }
    if (turn.status === "interrupted" || turn.status === "running") {
      return "core_restarted";
    }
    return "internal_error";
  }

  /** 检查 history 与已经持久化的 run terminal 是否一致。 */
  #terminalMatches(
    turn: HistoryTurn,
    event: Extract<AgentEvent, { type: "run.finished" }>,
  ): boolean {
    return (
      this.#historyStatus(event) === turn.status &&
      event.payload.reason === this.#historyReason(turn)
    );
  }

  /** 将底层 store 错误映射为安全的 SessionManager 错误。 */
  #fromStore(code: string, sessionId?: string): SessionManagerResult<never> {
    switch (code) {
      case "session_not_found":
        return this.#failure("session_not_found", "session not found", sessionId);
      case "session_corrupted":
        return this.#failure("session_corrupted", "session is corrupted", sessionId);
      case "idempotency_conflict":
      case "invalid_input":
      case "invalid_cursor":
        return this.#failure("invalid_params", "invalid session request", sessionId);
      default:
        return this.#internal("session storage operation failed");
    }
  }

  /** 构造带安全身份字段的失败。 */
  #failure(
    code: SessionManagerFailureCode,
    message: string,
    sessionId?: string,
  ): SessionManagerResult<never> {
    return { ok: false, error: { code, message, ...(sessionId ? { sessionId } : {}) } };
  }

  /** 构造不暴露底层路径或异常的内部错误。 */
  #internal(message: string): SessionManagerResult<never> {
    return { ok: false, error: { code: "internal_error", message } };
  }

  /** 串行化同一 session 的 accepted 临界区。 */
  #withSessionLock<Value>(sessionId: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(sessionId, tail);
    void tail.then(() => {
      if (this.#locks.get(sessionId) === tail) {
        this.#locks.delete(sessionId);
      }
    });
    return result;
  }

  /** 构造 session/run 联合身份键。 */
  #runKey(sessionId: string, runId: string): string {
    return `${sessionId}:${runId}`;
  }
}
