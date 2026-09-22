import { expandSkillCommand } from "../skills/command.ts";
import type {
  AgentCancelResult,
  AgentEvent,
  ClientMessageId,
  Environment,
  HistoryMessage,
  HistoryTurn,
  HistoryTurnReason,
  RunId,
  SessionCompactResult,
  SessionGetHistoryResult,
  SessionListResult,
  SessionMode,
  SessionId,
  SessionSendMessageResult,
  SessionSummary,
  TurnId,
} from "@minicode/protocol";
import {
  type CompactionCheckpoint,
  type CompactOptions,
  type ContextEntry,
  prepareCompaction,
} from "../compact/index.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { EventStore } from "../events/event-store.ts";
import type { SessionEventBus } from "../events/session-event-bus.ts";
import { LlmError } from "../llm/errors.ts";
import type { LlmMessage, LlmUsage } from "../llm/types.ts";
import type { RunCompletion } from "../run/completion.ts";
import { toHistoryMessages } from "../run/completion.ts";
import type { RunMetadataStore } from "../run/metadata.ts";
import type { AgentRunOutcome, AgentRunRequest } from "../run/runner.ts";
import { buildRunSnapshot } from "../run/runner.ts";
import type { RunSnapshot, RunSnapshotRequest } from "../run/snapshot.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { RunTraceRegistry } from "../trace/registry.ts";
import { loadCompactionConfig } from "./compaction-config.ts";
import {
  type ContextBudgetEstimator,
  defaultContextBudgetEstimator,
  loadContextBudgetConfig,
} from "./context-budget.ts";
import {
  buildContextEntries,
  buildContextMessages,
  latestCompaction,
  type SessionStore,
} from "./session-store.ts";
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
  recoverSubagents?(sessionId: SessionId, parentRunId: RunId): Promise<void>;
  run(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunOutcome>;
  prepareSnapshot?(request: RunSnapshotRequest): Promise<RunSnapshot>;
  compact?(
    options: CompactOptions,
  ): Promise<{ checkpoint: CompactionCheckpoint; entries: readonly ContextEntry[] } | undefined>;
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
  readonly userContent?: readonly import("../llm/types.ts").LlmContentPart[];
  readonly workspaceRoot: string;
  readonly history: readonly LlmMessage[];
  readonly contextEntries: readonly ContextEntry[];
  previousCheckpoint: CompactionCheckpoint | undefined;
  readonly snapshot: RunSnapshot;
  readonly trace: TraceRecorder;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  activated: boolean;
  acceptedPublished: boolean;
  acceptedPublication: Promise<boolean> | undefined;
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
  readonly #admissions = new Set<Promise<unknown>>();
  readonly #terminalCommits = new Set<Promise<void>>();
  readonly #active = new Map<string, ActiveExecution>();
  readonly #busySessions = new Set<string>();
  readonly #manualControllers = new Map<string, AbortController>();
  readonly #finishedRuns = new Set<string>();
  readonly #corruptedSessions = new Set<string>();
  readonly #ready: Promise<void>;
  #stopping = false;
  #recoveryFailed = false;

  /** 保存编排依赖并开始恢复已有 session 的持久状态。 */
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
    if (this.#recoveryFailed) {
      return this.#internal("session recovery did not complete");
    }
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
    if (this.#recoveryFailed) {
      return this.#internal("session recovery did not complete");
    }
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
    if (this.#recoveryFailed) {
      return this.#internal("session recovery did not complete");
    }
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
    if (this.#recoveryFailed) {
      return this.#internal("session recovery did not complete");
    }
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

  /** 空闲会话可主动摘要；与发送消息、其他压缩共享执行权，且不创建用户 turn。 */
  compact(sessionId: string, focus?: string): Promise<SessionManagerResult<SessionCompactResult>> {
    return this.#trackAdmission(this.#manualCompact(sessionId, focus));
  }

  /** 短临界区登记手动执行权，网络摘要在锁外执行，使并发请求立即得到 busy。 */
  async #manualCompact(
    sessionId: string,
    focus?: string,
  ): Promise<SessionManagerResult<SessionCompactResult>> {
    await this.#ready;
    const prepared = await this.#withSessionLock(
      sessionId,
      async (): Promise<SessionManagerResult<SessionSnapshot>> => {
        if (this.#stopping || this.#recoveryFailed) return this.#internal("core is unavailable");
        const loaded = await this.#store.load(sessionId);
        if (!loaded.ok) return this.#fromStore(loaded.error.code, sessionId);
        if (this.#corruptedSessions.has(sessionId))
          return this.#failure("session_corrupted", "session is corrupted", sessionId);
        if (this.#busySessions.has(sessionId) || loaded.value.activeRun !== undefined)
          return this.#failure("session_busy", "session already has active work", sessionId);
        this.#busySessions.add(sessionId);
        this.#manualControllers.set(sessionId, new AbortController());
        return loaded;
      },
    );
    if (!prepared.ok) return prepared;
    try {
      const snapshot = prepared.value;
      const files = await this.#store.loadContextFiles(snapshot.meta.workspaceRoot);
      if (!files.ok) return this.#internal("failed to read CONTEXT.md");
      const runSnapshot = await this.#prepareRunSnapshot({
        workspaceRoot: snapshot.meta.workspaceRoot,
        notes: snapshot.notes,
        files: files.value,
      });
      const entries = buildContextEntries(snapshot.turns, snapshot.compactions);
      const previous = latestCompaction(snapshot.turns, snapshot.compactions)?.checkpoint;
      const result = await this.#compactEntries(sessionId, runSnapshot, {
        entries,
        reason: "manual",
        tokensBefore:
          this.#estimator(runSnapshot.systemPrompt) +
          this.#estimator(runSnapshot.toolSchemas) +
          this.#estimator(entries.map(({ role, content }) => ({ role, content }))),
        signal: this.#manualControllers.get(sessionId)?.signal ?? AbortSignal.abort(),
        ...(focus === undefined ? {} : { focus }),
        ...(previous === undefined ? {} : { previous }),
      });
      return {
        ok: true,
        value:
          result === undefined
            ? { sessionId, status: "unchanged" }
            : { sessionId, status: "compacted", result: this.#compactionResult(result.checkpoint) },
      };
    } catch (error) {
      return error instanceof LlmError && error.code === "context_limit_exceeded"
        ? this.#failure("context_limit_exceeded", "context cannot fit after compaction", sessionId)
        : this.#internal("session compaction failed");
    } finally {
      this.#manualControllers.delete(sessionId);
      this.#busySessions.delete(sessionId);
    }
  }

  /** 执行器可扩展能力目录；旧测试执行器仍使用内置能力的统一快照。 */
  async #prepareRunSnapshot(request: RunSnapshotRequest): Promise<RunSnapshot> {
    return this.#runner.prepareSnapshot === undefined
      ? buildRunSnapshot(request.notes, request.files)
      : this.#runner.prepareSnapshot(request);
  }

  /** 生成、校验并落盘 checkpoint，再发布压缩完成事件；失败不安装新视图。 */
  async #compactEntries(
    sessionId: string,
    snapshot: RunSnapshot,
    options: CompactOptions,
    ownerRunId?: RunId,
  ) {
    const budget = loadContextBudgetConfig(this.#environment);
    if (!budget.ok) throw budget.error;
    const config = loadCompactionConfig(this.#environment, budget.value);
    if (!config.ok) throw config.error;
    if (prepareCompaction(options.entries, config.value.keepRecentTokens) === undefined)
      return undefined;
    const compactionId = this.#newId();
    const publish = async (event: Parameters<SessionEventBus["publish"]>[0]) => {
      const result = await this.#sessionEvents.publish(event);
      if (!result.ok) throw new Error("compaction event storage failed");
    };
    await publish({
      sessionId,
      timestamp: this.#now(),
      durable: true,
      type: "session.compaction_started",
      payload: { compactionId, reason: options.reason, tokensBefore: options.tokensBefore },
    });
    let storageFailed = false;
    try {
      const result = await this.#runner.compact?.({ ...options, compactionId });
      if (options.signal.aborted) throw new LlmError("aborted", "compaction cancelled");
      if (result === undefined) throw new LlmError("invalid_response", "compaction unavailable");
      const tokensAfter =
        this.#estimator(snapshot.systemPrompt) +
        this.#estimator(snapshot.toolSchemas) +
        this.#estimator(result.entries.map(({ role, content }) => ({ role, content })));
      if (tokensAfter + budget.value.maxOutputTokens > budget.value.contextWindowTokens)
        throw new LlmError("context_limit_exceeded", "retained context cannot fit");
      const checkpoint = { ...result.checkpoint, tokensAfter };
      const saved = await this.#store.appendCompaction(sessionId, checkpoint, ownerRunId);
      if (!saved.ok) {
        storageFailed = true;
        throw new Error("checkpoint storage failed");
      }
      await publish({
        sessionId,
        timestamp: this.#now(),
        durable: true,
        type: "session.compaction_finished",
        payload: { reason: options.reason, result: this.#compactionResult(checkpoint) },
      });
      return { ...result, checkpoint };
    } catch (error) {
      const code = options.signal.aborted
        ? "cancelled"
        : storageFailed
          ? "storage_error"
          : error instanceof LlmError && error.code === "context_limit_exceeded"
            ? "context_limit_exceeded"
            : "summary_failed";
      await publish({
        sessionId,
        timestamp: this.#now(),
        durable: true,
        type: "session.compaction_failed",
        payload: {
          compactionId,
          reason: options.reason,
          code,
          message: `compaction failed (${code})`,
        },
      });
      throw error;
    }
  }

  /** 只向 IPC 暴露压缩结果统计，摘要文本保留在内部 journal。 */
  #compactionResult(checkpoint: CompactionCheckpoint) {
    const { compactionId, kind, firstKeptMessageId, tokensBefore, tokensAfter } = checkpoint;
    return { compactionId, kind, firstKeptMessageId, tokensBefore, tokensAfter };
  }

  /** 为 chat session 做 accepted 前检查并准备一个延迟激活的 run。 */
  prepareMessage(input: {
    readonly sessionId: string;
    readonly clientMessageId: ClientMessageId;
    readonly content: string;
  }): Promise<SessionManagerResult<PreparedSessionRun>> {
    return this.#trackAdmission(this.#prepareMessage(input));
  }

  /** 执行 chat accepted 临界区；由公开入口同步登记为 shutdown admission。 */
  async #prepareMessage(input: {
    readonly sessionId: string;
    readonly clientMessageId: ClientMessageId;
    readonly content: string;
  }): Promise<SessionManagerResult<PreparedSessionRun>> {
    await this.#ready;
    if (this.#recoveryFailed) {
      return this.#internal("session recovery did not complete");
    }
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
  prepareOneShot(
    workspaceRoot: string,
    content: string,
  ): Promise<SessionManagerResult<PreparedSessionRun>> {
    return this.#trackAdmission(this.#prepareOneShot(workspaceRoot, content));
  }

  /** 执行 one_shot 创建与 accepted；由公开入口同步登记为 shutdown admission。 */
  async #prepareOneShot(
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
      if (active.commit !== undefined) {
        return "already_finished";
      }
      active.controller.abort();
      return "cancellation_requested";
    }
    return this.#finishedRuns.has(this.#runKey(sessionId, runId))
      ? "already_finished"
      : "not_found";
  }

  /** 在调用方排空响应闸门后，取消并等待所有 active run 完成确定的 terminal commit。 */
  async shutdown(): Promise<void> {
    this.beginShutdown();
    await this.#ready;
    // accepted 临界区只含本地持久化；先排空它，保证后续 active 快照不会漏 run。
    await Promise.allSettled([...this.#admissions]);
    const active = [...this.#active.values()];
    for (const execution of active) {
      execution.controller.abort();
    }
    await this.#waitBounded(active.map((execution) => execution.settled));
    const unfinished = active.filter((execution) =>
      this.#active.has(this.#runKey(execution.sessionId, execution.runId)),
    );
    await this.#waitBounded(unfinished.map((execution) => this.#forceShutdownCommit(execution)));
    await this.#waitBounded([...this.#terminalCommits]);
    await this.#traces.stopAll();
  }

  /** 同步封闭新 admission 并取消当前执行；供 Core 在关闭连接前启动两阶段停机。 */
  beginShutdown(): void {
    this.#stopping = true;
    for (const controller of this.#manualControllers.values()) controller.abort();
    for (const execution of this.#active.values()) {
      execution.controller.abort();
    }
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

    const history = buildContextMessages(snapshot.turns, snapshot.compactions);
    const files = await this.#store.loadContextFiles(snapshot.meta.workspaceRoot);
    if (!files.ok) return this.#internal("failed to read CONTEXT.md");
    const runSnapshot = await this.#prepareRunSnapshot({
      workspaceRoot: snapshot.meta.workspaceRoot,
      notes: snapshot.notes,
      files: files.value,
    });
    const expanded = expandSkillCommand(content, runSnapshot.skillCatalog);
    if (!expanded.ok)
      return this.#failure("invalid_params", expanded.message, snapshot.meta.sessionId);
    const budgetConfig = loadContextBudgetConfig(this.#environment);
    if (!budgetConfig.ok) {
      return this.#internal("context budget configuration is invalid");
    }
    const compactionConfig = loadCompactionConfig(this.#environment, budgetConfig.value);
    if (!compactionConfig.ok) return this.#internal("compaction configuration is invalid");
    // 固定提示词、工具定义与本轮提问不可压缩；历史在模型调用前按需处理。
    const fixedTokens =
      this.#estimator(runSnapshot.systemPrompt) +
      this.#estimator(runSnapshot.toolSchemas) +
      this.#estimator(expanded.userContent ?? content);
    if (fixedTokens + budgetConfig.value.maxOutputTokens > budgetConfig.value.contextWindowTokens) {
      return this.#failure(
        "context_limit_exceeded",
        "fixed context exceeds the configured budget",
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
      ...(expanded.userContent === undefined ? {} : { userContent: expanded.userContent }),
      workspaceRoot: snapshot.meta.workspaceRoot,
      history,
      contextEntries: buildContextEntries(snapshot.turns, snapshot.compactions),
      previousCheckpoint: latestCompaction(snapshot.turns, snapshot.compactions)?.checkpoint,
      snapshot: runSnapshot,
      trace: this.#traces.create(snapshot.meta.sessionId, runId),
      controller: new AbortController(),
      settled: deferred.promise,
      resolveSettled: deferred.resolve,
      activated: false,
      acceptedPublished: false,
      acceptedPublication: undefined,
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
    const traces = this.#traces;
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
        // 幂等重试只能复用 accepted 身份，不能越过首次请求的响应闸门抢先启动。
        if (active !== undefined && !idempotent) {
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
        // 只有首次 accepted 请求拥有关闭 response 门闩的资格；幂等重试不能抢先结束 Trace。
        if (!idempotent) {
          void traces.finishResponse(sessionId, runId);
        }
      },
    };
  }

  /** 幂等激活 prepared run；后台异常被收敛后仍完成 settled。 */
  #activate(execution: ActiveExecution): void {
    // 已进入终态提交或已从 active 集合移除时，迟到的响应/断连回调只能空操作。
    if (
      execution.activated ||
      execution.commit !== undefined ||
      !this.#active.has(this.#runKey(execution.sessionId, execution.runId))
    ) {
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
      } else if (execution.controller.signal.aborted) {
        outcome = { completion: this.#cancelledCompletion(execution.userMessage) };
      } else {
        const request: AgentRunRequest = {
          sessionId: execution.sessionId,
          runId: execution.runId,
          goal: execution.userMessage,
          ...(execution.userContent === undefined ? {} : { userContent: execution.userContent }),
          workspaceRoot: execution.workspaceRoot,
          history: execution.history,
          contextEntries: execution.contextEntries,
          compact: async (entries, tokensBefore, reason, signal) => {
            const result = await this.#compactEntries(
              execution.sessionId,
              execution.snapshot,
              {
                entries,
                tokensBefore,
                reason,
                signal,
                ...(execution.previousCheckpoint === undefined
                  ? {}
                  : { previous: execution.previousCheckpoint }),
              },
              execution.runId,
            );
            if (result !== undefined) execution.previousCheckpoint = result.checkpoint;
            return result?.entries;
          },
          systemPrompt: execution.snapshot.systemPrompt,
          snapshot: execution.snapshot,
          trace: execution.trace,
        };
        outcome = await this.#runner.run(request, execution.controller.signal);
        // provider/executor 即使忽略 AbortSignal，编排层仍以已接受的取消为权威结果。
        if (execution.controller.signal.aborted) {
          outcome = { completion: this.#cancelOutcome(outcome.completion) };
        }
      }
    } catch {
      outcome = execution.controller.signal.aborted
        ? { completion: this.#cancelledCompletion(execution.userMessage) }
        : { completion: this.#failedCompletion(execution.userMessage, "internal_error") };
    }
    await this.#commitOnce(execution, outcome);
  }

  /** 持久化并广播权威 turn_accepted；失败时不启动 provider。 */
  async #publishAccepted(execution: ActiveExecution): Promise<boolean> {
    if (execution.acceptedPublication !== undefined) {
      return execution.acceptedPublication;
    }
    const publication = this.#sessionEvents
      .publish({
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
      })
      .then((published) => {
        execution.acceptedPublished = published.ok;
        return published.ok;
      });
    execution.acceptedPublication = publication;
    return publication;
  }

  /** 保证正常返回、取消、shutdown 超时与异常路径只能进入同一个终态提交。 */
  #commitOnce(execution: ActiveExecution, outcome: AgentRunOutcome): Promise<void> {
    if (execution.commit !== undefined) {
      return execution.commit;
    }
    const commit = this.#commit(execution, outcome);
    execution.commit = commit;
    this.#terminalCommits.add(commit);
    void commit.then(
      () => this.#terminalCommits.delete(commit),
      () => this.#terminalCommits.delete(commit),
    );
    return commit;
  }

  /** transport 已关闭且 shutdown 超时后，补齐未激活 run 的生命周期并提交唯一终态。 */
  async #forceShutdownCommit(execution: ActiveExecution): Promise<void> {
    const wasActivated = execution.activated;
    // 抢占尚未释放响应闸门的执行权，防止强制收尾与迟到 activate 重复发布 accepted。
    execution.activated = true;
    if (!execution.acceptedPublished) {
      const published = await this.#publishAccepted(execution);
      if (!published) {
        this.#corruptedSessions.add(execution.sessionId);
      }
    }
    await this.#commitOnce(execution, {
      completion: this.#cancelledCompletion(execution.userMessage),
    });
    if (!wasActivated) {
      execution.resolveSettled();
    }
  }

  /** 严格按 history、active、run event、session event 的顺序提交 completion。 */
  async #commit(execution: ActiveExecution, outcome: AgentRunOutcome): Promise<void> {
    // commit 创建前接受的取消优先于 executor 返回值；创建后 cancel 会返回 already_finished。
    let completion = execution.controller.signal.aborted
      ? this.#cancelOutcome(outcome.completion)
      : outcome.completion;
    const messages = toHistoryMessages(
      completion.messages,
      execution.turnId,
      execution.runId,
      this.#now,
      completion.messageIds,
    );
    const persisted = await this.#store.appendCompleted(execution.sessionId, {
      turnId: execution.turnId,
      runId: execution.runId,
      status: completion.status,
      reason: completion.reason,
      messages,
      model: completion.model,
      ...(completion.taskGraph === undefined ? {} : { taskGraph: completion.taskGraph }),
      runResult: this.#runFinishedPayload(completion),
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
    await this.#traces.finishRun(execution.sessionId, execution.runId);
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
        this.#recoveryFailed = true;
        return;
      }
      for (const summary of page.value.sessions) {
        const loaded = await this.#store.load(summary.sessionId);
        if (!loaded.ok) {
          if (loaded.error.code === "session_corrupted") {
            this.#corruptedSessions.add(summary.sessionId);
          } else {
            this.#recoveryFailed = true;
            return;
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
      await this.#runner.recoverSubagents?.(snapshot.meta.sessionId, turn.runId);
      const journal = await this.#eventStore.read(snapshot.meta.sessionId, turn.runId);
      if (!journal.ok) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }
      const terminals = journal.value.events.filter((event) => event.type === "run.finished");
      if (terminals.length > 1) {
        this.#corruptedSessions.add(snapshot.meta.sessionId);
        return;
      }
      const terminal = terminals[0];
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
          runResult: {
            status: "failed",
            reason: "core_restarted",
            finalText: "",
            steps: 0,
            usage: EMPTY_USAGE,
          },
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
        const payload = this.#payloadFromHistory(recoveredTurn, snapshot.runResults[turn.runId]);
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
      if (event.type !== "session.turn_accepted" && event.type !== "session.turn_finished")
        continue;
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

  /** 取消改变终态而保留已经生成的完整审计与用量，checkpoint 因 owner 取消而失效。 */
  #cancelOutcome(completion: RunCompletion): RunCompletion {
    const { error: _error, ...rest } = completion;
    return { ...rest, status: "cancelled", reason: "cancelled", finalText: "" };
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
  #payloadFromHistory(
    turn: HistoryTurn,
    persisted?: Extract<AgentEvent, { type: "run.finished" }>["payload"],
  ): Extract<AgentEvent, { type: "run.finished" }>["payload"] {
    if (persisted !== undefined) {
      return persisted;
    }
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

  /** 同步登记 accepted admission，使 shutdown 不会漏掉已开始但尚未注册 active 的请求。 */
  #trackAdmission<Value>(operation: Promise<Value>): Promise<Value> {
    this.#admissions.add(operation);
    void operation.then(
      () => this.#admissions.delete(operation),
      () => this.#admissions.delete(operation),
    );
    return operation;
  }

  /** 构造 session/run 联合身份键。 */
  #runKey(sessionId: string, runId: string): string {
    return `${sessionId}:${runId}`;
  }
}
