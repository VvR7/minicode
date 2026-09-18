import { listSkills } from "./skills.ts";
import type {
  ActiveRun,
  AgentCancelResult,
  AgentEvent,
  ClientMessageId,
  CoreEndpoint,
  HistoryTurn,
  JsonRpcNotificationEnvelope,
  PermissionDecision,
  PermissionRequestId,
  PermissionRespondResult,
  RunId,
  SessionEvent,
  SessionCompactResult,
  SessionId,
  SessionListParams,
  SessionListResult,
  SessionSendMessageResult,
  SessionSummary,
  SubscriptionId,
  TurnId,
} from "@minicode/protocol";
import {
  AGENT_CANCEL_METHOD,
  AgentCancelResultSchema,
  EVENT_SUBSCRIBE_METHOD,
  EVENT_UNSUBSCRIBE_METHOD,
  EventPushNotificationSchema,
  EventSubscribeResultSchema,
  EventUnsubscribeResultSchema,
  isAgentEvent,
  isSessionEvent,
  PERMISSION_RESPOND_METHOD,
  PermissionRespondParamsSchema,
  PermissionRespondResultSchema,
  SESSION_CREATE_METHOD,
  SESSION_COMPACT_METHOD,
  SessionCompactParamsSchema,
  SessionCompactResultSchema,
  SESSION_GET_HISTORY_METHOD,
  SESSION_LIST_METHOD,
  SESSION_SEND_MESSAGE_METHOD,
  SESSION_SUBSCRIBE_METHOD,
  SessionCreateResultSchema,
  SessionGetHistoryResultSchema,
  SessionListResultSchema,
  SessionSendMessageResultSchema,
  SessionSubscribeResultSchema,
} from "@minicode/protocol";
import { NdjsonRpcConnection, RpcClientError } from "./ndjson-rpc-client.ts";
import { type ClientPermission, PermissionState } from "./permission-state.ts";

export type SessionCompactionEvent = Extract<
  SessionEvent,
  {
    type:
      | "session.compaction_started"
      | "session.compaction_finished"
      | "session.compaction_failed";
  }
>;

/** SessionController 对 TUI 输出的唯一、已校验且去重的事件流。 */
export type SessionControllerEvent =
  | { readonly type: "controller.status"; readonly status: SessionControllerStatus }
  | { readonly type: "session.attached"; readonly session: SessionSummary }
  | { readonly type: "turn.snapshot"; readonly turn: HistoryTurn }
  | {
      readonly type: "turn.accepted";
      readonly sessionId: SessionId;
      readonly sessionSequence: number;
      readonly turnId: TurnId;
      readonly runId: RunId;
      readonly clientMessageId: ClientMessageId;
      readonly userMessage: string;
    }
  | { readonly type: "run.event"; readonly event: AgentEvent }
  | { readonly type: "session.compaction"; readonly event: SessionCompactionEvent }
  | {
      readonly type: "turn.committed";
      readonly sessionId: SessionId;
      readonly sessionSequence: number;
      readonly turnId: TurnId;
      readonly runId: RunId;
      readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
      readonly reason?: HistoryTurn["reason"];
    };

/** Controller 连接状态；TUI 可直接据此更新状态栏。 */
export type SessionControllerStatus = "connecting" | "connected" | "reconnecting" | "disposed";

/** consumer 返回的 Promise 完成后，controller 才推进对应持久 cursor。 */
export type SessionControllerConsumer = (event: SessionControllerEvent) => void | Promise<void>;

/** 供测试注入的连接工厂。 */
export type SessionControllerConnector = (endpoint: CoreEndpoint) => Promise<NdjsonRpcConnection>;

export interface SessionControllerOptions {
  readonly endpoint: CoreEndpoint;
  readonly onEvent: SessionControllerConsumer;
  readonly connect?: SessionControllerConnector;
  readonly reconnectDelayMs?: number;
  readonly onPermissions?: (permissions: readonly ClientPermission[]) => void;
}

interface RunObservation {
  readonly turnId: TurnId;
  readonly runId: RunId;
  subscriptionId: SubscriptionId | undefined;
  cursor: number;
  finished: boolean;
}

interface QueuedNotification {
  readonly connection: NdjsonRpcConnection;
  readonly notification: JsonRpcNotificationEnvelope;
}

/** 可被 dispose 打断的短暂重连等待。 */
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * 多轮会话客户端：把 history、session journal 与 run journal 合并为单一事件流，
 * 并在断线后使用两个独立 cursor 恢复订阅。
 */
export class SessionController {
  #permissions = new PermissionState();
  #onPermissions: SessionControllerOptions["onPermissions"];
  readonly #endpoint: CoreEndpoint;
  readonly #consumer: SessionControllerConsumer;
  readonly #connect: SessionControllerConnector;
  readonly #reconnectDelayMs: number;
  #lifecycle = new AbortController();
  #connection: NdjsonRpcConnection | undefined;
  #stopNotifications: (() => void) | undefined;
  #session: SessionSummary | undefined;
  #workspaceRoot: string | undefined;
  #sessionCursor = 0;
  #sessionSubscriptionId: SubscriptionId | undefined;
  #runs = new Map<RunId, RunObservation>();
  #runBySubscription = new Map<SubscriptionId, RunObservation>();
  #turnSnapshots = new Map<TurnId, string>();
  #knownTurns = new Set<TurnId>();
  #committedTurns = new Set<TurnId>();
  #pendingCommits = new Map<RunId, Extract<SessionEvent, { type: "session.turn_finished" }>>();
  #deferredSessionEvents: SessionEvent[] = [];
  #activeRun: ActiveRun | undefined;
  #notificationQueue: QueuedNotification[] = [];
  #drainTask: Promise<void> | undefined;
  #notificationsPaused = true;
  #ready = Promise.withResolvers<void>();
  #watchTask: Promise<void> | undefined;

  /** 保存连接配置与单一事件 consumer；实例在 attach/create 前不建立连接。 */
  constructor(options: SessionControllerOptions) {
    this.#onPermissions = options.onPermissions;
    this.#endpoint = options.endpoint;
    this.#consumer = options.onEvent;
    this.#connect = options.connect ?? ((endpoint) => NdjsonRpcConnection.connect(endpoint));
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 100;
  }

  /** 创建 chat session，随后按标准 attach 流程接入。 */
  async create(workspaceRoot: string): Promise<SessionSummary> {
    await this.#leaveCurrentSession();
    const connection = await this.#connect(this.#endpoint);
    let session: SessionSummary;
    try {
      const response = await connection.request(
        SESSION_CREATE_METHOD,
        { workspaceRoot },
        SessionCreateResultSchema,
      );
      session = response.result.session;
    } finally {
      connection.close();
    }
    await this.attach(session.sessionId);
    return session;
  }

  /** 附着指定 session；成功返回时 history 已消费且 live subscription 已建立。 */
  async attach(sessionId: SessionId): Promise<void> {
    await this.#leaveCurrentSession();
    this.#resetLifecycle();
    try {
      await this.#openAndAttach(sessionId, false);
    } catch (error) {
      await this.#leaveCurrentSession();
      throw error;
    }
    this.#watchTask = this.#watchConnection(sessionId);
  }

  /** 查询 session 列表；该操作不改变当前附着会话。 */
  async list(options: Partial<SessionListParams> = {}): Promise<SessionListResult> {
    const connection = await this.#connect(this.#endpoint);
    try {
      const response = await connection.request(
        SESSION_LIST_METHOD,
        {
          includeOneShot: options.includeOneShot ?? false,
          limit: options.limit ?? 50,
          ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        },
        SessionListResultSchema,
      );
      return response.result;
    } finally {
      connection.close();
    }
  }

  /**
   * 提交消息。响应不确定时保留同一 clientMessageId 和内容，待重连后幂等重试。
   * application error（例如 session_busy）直接抛给 TUI，不产生本地 user 行。
   */
  async sendMessage(content: string): Promise<SessionSendMessageResult> {
    const sessionId = this.#requiredSessionId();
    const clientMessageId = crypto.randomUUID() as ClientMessageId;
    for (;;) {
      const connection = await this.#waitForConnection();
      try {
        const response = await connection.request(
          SESSION_SEND_MESSAGE_METHOD,
          { sessionId, clientMessageId, content },
          SessionSendMessageResultSchema,
        );
        return response.result;
      } catch (error) {
        if (error instanceof RpcClientError && error.code !== undefined) throw error;
        if (this.#lifecycle.signal.aborted || this.#session?.sessionId !== sessionId) throw error;
        connection.close();
        await this.#waitForConnection(connection);
      }
    }
  }

  /** 查询已附着会话工作区的技能目录，不创建聊天轮次。 */
  async listSkills(): Promise<import("@minicode/protocol").SkillListResult> {
    this.#requiredSessionId();
    const session = this.#session;
    if (!session) throw new Error("session is not attached");
    return listSkills(await this.#waitForConnection(), session.workspaceRoot);
  }

  /** 在当前会话请求独立压缩；断线不重复发起摘要，后续进度由会话事件恢复。 */
  async compact(focus?: string): Promise<SessionCompactResult> {
    const params = SessionCompactParamsSchema.parse({
      sessionId: this.#requiredSessionId(),
      ...(focus === undefined ? {} : { focus }),
    });
    const connection = await this.#waitForConnection();
    const response = await connection.request(
      SESSION_COMPACT_METHOD,
      params,
      SessionCompactResultSchema,
      { timeoutMs: 300000 },
    );
    return response.result;
  }

  /** 取消当前权威 active run；没有 active run 时返回 already_finished。 */
  async cancelActiveRun(): Promise<AgentCancelResult> {
    const activeRun = this.#activeRun;
    const sessionId = this.#requiredSessionId();
    if (activeRun === undefined) return { outcome: "already_finished" };
    const connection = await this.#waitForConnection();
    const response = await connection.request(
      AGENT_CANCEL_METHOD,
      { sessionId, runId: activeRun.runId },
      AgentCancelResultSchema,
    );
    return response.result;
  }

  /** 暴露当前 session 的审批投影，供前端显示待处理和已解决请求。 */
  get permissions(): readonly ClientPermission[] {
    return this.#permissions.snapshot;
  }

  /** 已附着 session 才能发送审批；结果不乐观覆盖 durable 决策。 */
  async respondPermission(
    runId: RunId,
    id: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<PermissionRespondResult> {
    const sessionId = this.#requiredSessionId();
    const params = PermissionRespondParamsSchema.parse({
      sessionId,
      runId,
      permissionRequestId: id,
      decision,
    });
    const entry = this.permissions.find(
      (entry) => entry.request.runId === runId && entry.request.payload.permissionRequestId === id,
    );
    if (entry !== undefined && !entry.request.payload.cacheable && decision.startsWith("always_"))
      throw new Error("always decisions are unavailable for this request");
    const connection = await this.#waitForConnection();
    if (this.#session?.sessionId !== sessionId) throw new Error("attached session changed");
    try {
      const response = await connection.request(
        PERMISSION_RESPOND_METHOD,
        params,
        PermissionRespondResultSchema,
      );
      const result = PermissionRespondResultSchema.parse(response.result);
      if (result.outcome !== "accepted" && entry !== undefined && this.#permissions.close(id))
        this.#onPermissions?.(this.permissions);
      return result;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /** 仅切换当前 controller：释放旧订阅后在同 workspace 创建并附着新 session。 */
  async switchToNewSession(): Promise<SessionSummary> {
    const workspaceRoot = this.#workspaceRoot;
    if (workspaceRoot === undefined) throw new Error("no session is attached");
    return this.create(workspaceRoot);
  }

  /** 幂等释放连接、listener 与订阅；不会影响其他 controller。 */
  async dispose(): Promise<void> {
    await this.#leaveCurrentSession();
    await this.#emit({ type: "controller.status", status: "disposed" });
  }

  /** 返回当前 session；未 attach 时为 undefined。 */
  get currentSession(): SessionSummary | undefined {
    return this.#session;
  }

  /** 清理旧连接并重置会话级 reducer source。 */
  async #leaveCurrentSession(): Promise<void> {
    this.#lifecycle.abort();
    this.#ready.resolve();
    const connection = this.#connection;
    if (connection !== undefined) {
      const subscriptions = [
        ...(this.#sessionSubscriptionId === undefined ? [] : [this.#sessionSubscriptionId]),
        ...this.#runBySubscription.keys(),
      ];
      await Promise.all(
        subscriptions.map(async (subscriptionId) => {
          try {
            await connection.request(
              EVENT_UNSUBSCRIBE_METHOD,
              { subscriptionId },
              EventUnsubscribeResultSchema,
            );
          } catch {
            // 断线或重复 unsubscribe 由 socket 生命周期兜底清理。
          }
        }),
      );
      connection.close();
    }
    this.#detachNotificationListener();
    await this.#drainTask;
    await this.#watchTask;
    this.#watchTask = undefined;
    this.#connection = undefined;
    this.#session = undefined;
    this.#permissions.clear();
    this.#onPermissions?.(this.permissions);
    this.#sessionCursor = 0;
    this.#sessionSubscriptionId = undefined;
    this.#runs.clear();
    this.#runBySubscription.clear();
    this.#turnSnapshots.clear();
    this.#knownTurns.clear();
    this.#committedTurns.clear();
    this.#pendingCommits.clear();
    this.#deferredSessionEvents = [];
    this.#activeRun = undefined;
    this.#notificationQueue = [];
    this.#drainTask = undefined;
    this.#notificationsPaused = true;
  }

  /** 为新 attach 创建独立的关闭信号和 ready gate。 */
  #resetLifecycle(): void {
    this.#lifecycle = new AbortController();
    this.#ready = Promise.withResolvers<void>();
  }

  /** 建立连接，并严格按 history -> session subscribe -> history emit -> run subscribe 接入。 */
  async #openAndAttach(sessionId: SessionId, reconnecting: boolean): Promise<void> {
    await this.#emit({
      type: "controller.status",
      status: reconnecting ? "reconnecting" : "connecting",
    });
    const connection = await this.#connect(this.#endpoint);
    if (this.#lifecycle.signal.aborted) {
      connection.close();
      throw new Error("session controller is disposed");
    }
    this.#connection = connection;
    this.#notificationsPaused = true;
    this.#stopNotifications = connection.onNotification((notification) =>
      this.#enqueueNotification(connection, notification),
    );

    const historyResponse = await connection.request(
      SESSION_GET_HISTORY_METHOD,
      { sessionId },
      SessionGetHistoryResultSchema,
    );
    const history = historyResponse.result;
    const subscribed = await connection.request(
      SESSION_SUBSCRIBE_METHOD,
      // history 只包含 turn；从已消费 cursor 回放才能恢复独立压缩事件与占用。
      { sessionId, afterSequence: this.#sessionCursor },
      SessionSubscribeResultSchema,
    );
    this.#session = history.session;
    this.#workspaceRoot = history.session.workspaceRoot;
    this.#sessionSubscriptionId = subscribed.result.subscriptionId;
    this.#activeRun = subscribed.result.activeRun ?? history.session.activeRun;

    await this.#emit({ type: "session.attached", session: history.session });
    for (const turn of history.turns) await this.#applyHistoryTurn(turn);
    for (const pendingCommit of [...this.#pendingCommits.values()]) {
      if (this.#committedTurns.has(pendingCommit.payload.turnId)) {
        await this.#commitTurn(pendingCommit);
      }
    }

    const runsToObserve = new Map<RunId, ActiveRun>();
    for (const turn of history.turns) {
      if (turn.status === "running") {
        runsToObserve.set(turn.runId, { turnId: turn.turnId, runId: turn.runId });
      }
    }
    if (history.session.activeRun !== undefined) {
      runsToObserve.set(history.session.activeRun.runId, history.session.activeRun);
    }
    if (subscribed.result.activeRun !== undefined) {
      runsToObserve.set(subscribed.result.activeRun.runId, subscribed.result.activeRun);
    }
    for (const observation of this.#runs.values()) {
      if (!observation.finished) {
        runsToObserve.set(observation.runId, {
          turnId: observation.turnId,
          runId: observation.runId,
        });
      }
    }
    for (const run of runsToObserve.values()) await this.#observeRun(run.turnId, run.runId);
    this.#notificationsPaused = false;
    await this.#drainNotifications();
    await this.#emit({ type: "controller.status", status: "connected" });
    this.#ready.resolve();
    this.#onPermissions?.(this.permissions);
  }

  /** 监听断线并使用已成功消费的 cursor 重建 history/session/run 三个来源。 */
  async #watchConnection(sessionId: SessionId): Promise<void> {
    while (!this.#lifecycle.signal.aborted) {
      const connection = this.#connection;
      if (connection === undefined) return;
      await connection.waitUntilClosed();
      if (this.#lifecycle.signal.aborted) return;
      await this.#drainTask;
      this.#detachNotificationListener();
      if (this.#connection === connection) this.#connection = undefined;
      this.#sessionSubscriptionId = undefined;
      this.#runBySubscription.clear();
      for (const observation of this.#runs.values()) observation.subscriptionId = undefined;
      this.#ready = Promise.withResolvers<void>();
      await this.#emit({ type: "controller.status", status: "reconnecting" });
      for (;;) {
        if (this.#lifecycle.signal.aborted) return;
        await waitForRetry(this.#reconnectDelayMs, this.#lifecycle.signal);
        if (this.#lifecycle.signal.aborted) return;
        try {
          await this.#openAndAttach(sessionId, true);
          break;
        } catch {
          this.#detachNotificationListener();
          this.#connection?.close();
          this.#connection = undefined;
          this.#sessionSubscriptionId = undefined;
          this.#runBySubscription.clear();
          for (const observation of this.#runs.values()) observation.subscriptionId = undefined;
        }
      }
    }
  }

  /** 移除当前连接的 notification listener，重复调用安全。 */
  #detachNotificationListener(): void {
    const stop = this.#stopNotifications;
    this.#stopNotifications = undefined;
    stop?.();
  }

  /** 历史 snapshot 按 turnId 内容去重；变更时作为权威替换事件输出。 */
  async #applyHistoryTurn(turn: HistoryTurn): Promise<void> {
    const fingerprint = JSON.stringify(turn);
    if (this.#turnSnapshots.get(turn.turnId) === fingerprint) return;
    await this.#emit({ type: "turn.snapshot", turn });
    this.#turnSnapshots.set(turn.turnId, fingerprint);
    this.#knownTurns.add(turn.turnId);
    if (turn.status !== "running") {
      this.#committedTurns.add(turn.turnId);
    }
  }

  /** 建立精确 run subscription；同一 run 在一条连接上只订阅一次。 */
  async #observeRun(turnId: TurnId, runId: RunId): Promise<void> {
    let observation = this.#runs.get(runId);
    if (observation === undefined) {
      observation = { turnId, runId, subscriptionId: undefined, cursor: 0, finished: false };
      this.#runs.set(runId, observation);
    }
    if (observation.subscriptionId !== undefined) return;
    const connection = this.#connection;
    if (connection === undefined) return;
    const response = await connection.request(
      EVENT_SUBSCRIBE_METHOD,
      { sessionId: this.#requiredSessionId(), runId, afterSequence: observation.cursor },
      EventSubscribeResultSchema,
    );
    observation.subscriptionId = response.result.subscriptionId;
    this.#runBySubscription.set(response.result.subscriptionId, observation);
  }

  /** notification 先入队，再由串行 consumer 推进 cursor，避免网络接收抢跑。 */
  #enqueueNotification(
    connection: NdjsonRpcConnection,
    notification: JsonRpcNotificationEnvelope,
  ): void {
    this.#notificationQueue.push({ connection, notification });
    if (!this.#notificationsPaused) {
      void this.#drainNotifications();
    }
  }

  /** 串行消费所有已入队 notification；并发调用共享同一个 drain Promise。 */
  #drainNotifications(): Promise<void> {
    if (this.#drainTask !== undefined) return this.#drainTask;
    const completion = Promise.withResolvers<void>();
    const task = completion.promise;
    // 先登记共享 Promise，再启动 drain，避免同步 fake/transport 回调重入第二个 consumer。
    this.#drainTask = task;
    void this.#runNotificationDrain().then(completion.resolve, completion.reject);
    void task.finally(() => {
      if (this.#drainTask === task) this.#drainTask = undefined;
      if (!this.#notificationsPaused && this.#notificationQueue.length > 0) {
        void this.#drainNotifications();
      }
    });
    return task;
  }

  /** 消费队列；consumer 失败只丢弃并关闭同一旧连接的数据，等待 journal 重放。 */
  async #runNotificationDrain(): Promise<void> {
    while (this.#notificationQueue.length > 0) {
      const queued = this.#notificationQueue.shift();
      if (queued === undefined) continue;
      try {
        await this.#applyNotification(queued.notification);
      } catch {
        queued.connection.close();
        this.#notificationQueue = this.#notificationQueue.filter(
          (candidate) => candidate.connection !== queued.connection,
        );
      }
    }
  }

  /** 校验 subscription scope 与身份后合并 session/run event。 */
  async #applyNotification(notification: JsonRpcNotificationEnvelope): Promise<void> {
    const parsed = EventPushNotificationSchema.safeParse(notification);
    if (!parsed.success || this.#session === undefined) return;
    const { subscriptionId, event } = parsed.data.params;
    if (subscriptionId === this.#sessionSubscriptionId && isSessionEvent(event)) {
      if (
        this.#pendingCommits.size > 0 &&
        (!("runId" in event.payload) || !this.#pendingCommits.has(event.payload.runId))
      ) {
        this.#deferredSessionEvents.push(event);
        return;
      }
      await this.#applySessionEvent(event);
      return;
    }
    const observation = this.#runBySubscription.get(subscriptionId);
    if (observation === undefined || !isAgentEvent(event)) return;
    if (event.sessionId !== this.#session.sessionId || event.runId !== observation.runId) return;
    if (event.sequence <= observation.cursor) return;
    await this.#emit({ type: "run.event", event });
    if (this.#permissions.apply(event)) this.#onPermissions?.(this.permissions);
    observation.cursor = event.sequence;
    if (event.type === "run.finished") {
      observation.finished = true;
      const pendingCommit = this.#pendingCommits.get(event.runId);
      if (pendingCommit !== undefined) {
        await this.#commitTurn(pendingCommit);
      } else if (this.#committedTurns.has(observation.turnId)) {
        this.#releaseRunObservation(observation);
      }
    }
  }

  /** 合并并去重 session journal；accepted 会先确保对应 run journal 已接入。 */
  async #applySessionEvent(event: SessionEvent): Promise<void> {
    if (this.#session === undefined || event.sessionId !== this.#session.sessionId) return;
    if (event.sessionSequence <= this.#sessionCursor) return;
    if (event.type === "session.turn_accepted" && !this.#committedTurns.has(event.payload.turnId)) {
      this.#activeRun = { turnId: event.payload.turnId, runId: event.payload.runId };
      await this.#observeRun(event.payload.turnId, event.payload.runId);
      if (!this.#knownTurns.has(event.payload.turnId)) {
        await this.#emit({
          type: "turn.accepted",
          sessionId: event.sessionId,
          sessionSequence: event.sessionSequence,
          ...event.payload,
        });
        this.#knownTurns.add(event.payload.turnId);
      }
    } else if (
      event.type === "session.turn_finished" &&
      (!this.#committedTurns.has(event.payload.turnId) ||
        this.#pendingCommits.has(event.payload.runId))
    ) {
      const observation = this.#runs.get(event.payload.runId);
      if (observation !== undefined && !observation.finished) {
        this.#pendingCommits.set(event.payload.runId, event);
        return;
      }
      await this.#commitTurn(event);
    }
    if (
      event.type === "session.compaction_started" ||
      event.type === "session.compaction_finished" ||
      event.type === "session.compaction_failed"
    ) {
      await this.#emit({ type: "session.compaction", event });
    }
    this.#sessionCursor = event.sessionSequence;
  }

  /** 在 run 详细终态已消费后，输出唯一的 turn 提交终态并推进 session cursor。 */
  async #commitTurn(
    event: Extract<SessionEvent, { type: "session.turn_finished" }>,
  ): Promise<void> {
    await this.#emit({
      type: "turn.committed",
      sessionId: event.sessionId,
      sessionSequence: event.sessionSequence,
      ...event.payload,
    });
    this.#committedTurns.add(event.payload.turnId);
    this.#pendingCommits.delete(event.payload.runId);
    if (this.#activeRun?.runId === event.payload.runId) this.#activeRun = undefined;
    const observation = this.#runs.get(event.payload.runId);
    if (observation?.finished) this.#releaseRunObservation(observation);
    this.#sessionCursor = event.sessionSequence;
    const deferred = this.#deferredSessionEvents
      .splice(0)
      .sort((left, right) => left.sessionSequence - right.sessionSequence);
    for (const next of deferred) await this.#applySessionEvent(next);
  }

  /** run 详细终态与 session commit 都已交付后，释放本地订阅索引。 */
  #releaseRunObservation(observation: RunObservation): void {
    if (observation.subscriptionId !== undefined) {
      this.#runBySubscription.delete(observation.subscriptionId);
    }
    this.#runs.delete(observation.runId);
  }

  /** 等待当前或重连后的可用连接；可指定排除刚失败的旧连接。 */
  async #waitForConnection(previous?: NdjsonRpcConnection): Promise<NdjsonRpcConnection> {
    for (;;) {
      if (this.#lifecycle.signal.aborted) throw new Error("session controller is disposed");
      const connection = this.#connection;
      if (
        connection !== undefined &&
        !connection.closed &&
        connection !== previous &&
        !this.#notificationsPaused &&
        this.#sessionSubscriptionId !== undefined
      )
        return connection;
      await this.#ready.promise;
    }
  }

  /** 获取当前 sessionId，避免未 attach 时发出无归属请求。 */
  #requiredSessionId(): SessionId {
    if (this.#session === undefined) throw new Error("no session is attached");
    return this.#session.sessionId;
  }

  /** 所有 controller 事件统一经过可等待 consumer。 */
  async #emit(event: SessionControllerEvent): Promise<void> {
    await this.#consumer(event);
  }
}
