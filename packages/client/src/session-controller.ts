import type {
  ActiveRun,
  AgentCancelResult,
  AgentEvent,
  ClientMessageId,
  CoreEndpoint,
  HistoryTurn,
  JsonRpcNotificationEnvelope,
  RunId,
  SessionEvent,
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
  SESSION_CREATE_METHOD,
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
}

interface RunObservation {
  readonly turnId: TurnId;
  readonly runId: RunId;
  subscriptionId: SubscriptionId | undefined;
  cursor: number;
  finished: boolean;
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
  #notificationQueue: JsonRpcNotificationEnvelope[] = [];
  #draining = false;
  #notificationsPaused = true;
  #ready = Promise.withResolvers<void>();
  #watchTask: Promise<void> | undefined;

  /** 保存连接配置与单一事件 consumer；实例在 attach/create 前不建立连接。 */
  constructor(options: SessionControllerOptions) {
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
    await this.#watchTask;
    this.#watchTask = undefined;
    this.#connection = undefined;
    this.#session = undefined;
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
    this.#draining = false;
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
      this.#enqueueNotification(notification),
    );

    const historyResponse = await connection.request(
      SESSION_GET_HISTORY_METHOD,
      { sessionId },
      SessionGetHistoryResultSchema,
    );
    const history = historyResponse.result;
    const subscribed = await connection.request(
      SESSION_SUBSCRIBE_METHOD,
      { sessionId, afterSequence: Math.max(this.#sessionCursor, history.throughSessionSequence) },
      SessionSubscribeResultSchema,
    );
    this.#session = history.session;
    this.#workspaceRoot = history.session.workspaceRoot;
    this.#sessionSubscriptionId = subscribed.result.subscriptionId;
    this.#activeRun = subscribed.result.activeRun ?? history.session.activeRun;

    await this.#emit({ type: "session.attached", session: history.session });
    for (const turn of history.turns) await this.#applyHistoryTurn(turn);
    this.#sessionCursor = Math.max(this.#sessionCursor, history.throughSessionSequence);

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
  }

  /** 监听断线并使用已成功消费的 cursor 重建 history/session/run 三个来源。 */
  async #watchConnection(sessionId: SessionId): Promise<void> {
    while (!this.#lifecycle.signal.aborted) {
      const connection = this.#connection;
      if (connection === undefined) return;
      await connection.waitUntilClosed();
      if (this.#lifecycle.signal.aborted) return;
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
      this.#pendingCommits.delete(turn.runId);
      if (this.#pendingCommits.size === 0) this.#deferredSessionEvents = [];
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
  #enqueueNotification(notification: JsonRpcNotificationEnvelope): void {
    this.#notificationQueue.push(notification);
    if (!this.#notificationsPaused) {
      void this.#drainNotifications().catch(() => this.#connection?.close());
    }
  }

  /** 串行消费所有已入队 notification。 */
  async #drainNotifications(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#notificationQueue.length > 0) {
        const notification = this.#notificationQueue.shift();
        if (notification !== undefined) await this.#applyNotification(notification);
      }
    } finally {
      this.#draining = false;
    }
  }

  /** 校验 subscription scope 与身份后合并 session/run event。 */
  async #applyNotification(notification: JsonRpcNotificationEnvelope): Promise<void> {
    const parsed = EventPushNotificationSchema.safeParse(notification);
    if (!parsed.success || this.#session === undefined) return;
    const { subscriptionId, event } = parsed.data.params;
    if (subscriptionId === this.#sessionSubscriptionId && isSessionEvent(event)) {
      if (this.#pendingCommits.size > 0 && !this.#pendingCommits.has(event.payload.runId)) {
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
    observation.cursor = event.sequence;
    if (event.type === "run.finished") {
      observation.finished = true;
      const pendingCommit = this.#pendingCommits.get(event.runId);
      if (pendingCommit !== undefined) {
        this.#pendingCommits.delete(event.runId);
        await this.#commitTurn(pendingCommit);
      }
    }
  }

  /** 合并并去重 session journal；accepted 会先确保对应 run journal 已接入。 */
  async #applySessionEvent(event: SessionEvent): Promise<void> {
    if (this.#session === undefined || event.sessionId !== this.#session.sessionId) return;
    if (event.sessionSequence <= this.#sessionCursor) return;
    if (event.type === "session.turn_accepted") {
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
    } else if (!this.#committedTurns.has(event.payload.turnId)) {
      const observation = this.#runs.get(event.payload.runId);
      if (observation !== undefined && !observation.finished) {
        this.#pendingCommits.set(event.payload.runId, event);
        return;
      }
      await this.#commitTurn(event);
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
    if (this.#activeRun?.runId === event.payload.runId) this.#activeRun = undefined;
    this.#sessionCursor = event.sessionSequence;
    const deferred = this.#deferredSessionEvents
      .splice(0)
      .sort((left, right) => left.sessionSequence - right.sessionSequence);
    for (const next of deferred) await this.#applySessionEvent(next);
  }

  /** 等待当前或重连后的可用连接；可指定排除刚失败的旧连接。 */
  async #waitForConnection(previous?: NdjsonRpcConnection): Promise<NdjsonRpcConnection> {
    for (;;) {
      if (this.#lifecycle.signal.aborted) throw new Error("session controller is disposed");
      const connection = this.#connection;
      if (connection !== undefined && !connection.closed && connection !== previous)
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
