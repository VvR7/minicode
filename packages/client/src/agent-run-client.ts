import type {
  AgentEvent,
  CoreEndpoint,
  PermissionDecision,
  PermissionRequestId,
  PermissionRespondResult,
  RunId,
  SessionId,
  SubscriptionId,
} from "@minicode/protocol";
import {
  AGENT_CANCEL_METHOD,
  AGENT_RUN_METHOD,
  AgentCancelResultSchema,
  AgentRunResultSchema,
  EVENT_SUBSCRIBE_METHOD,
  EventPushNotificationSchema,
  EventSubscribeResultSchema,
  isAgentEvent,
  isSessionEvent,
  SESSION_SUBSCRIBE_METHOD,
  SessionSubscribeResultSchema,
  PERMISSION_RESPOND_METHOD,
  PermissionRespondParamsSchema,
  PermissionRespondResultSchema,
} from "@minicode/protocol";
import type { SessionCompactionEvent } from "./session-controller.ts";
import { NdjsonRpcConnection, RpcClientError } from "./ndjson-rpc-client.ts";
import { type ClientPermission, PermissionState } from "./permission-state.ts";

/** 一次 run 的 sessionId/runId 标识，run 建立后不再变化。 */
interface RunIdentity {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** 连接生命周期状态，供前端更新界面；仅报告状态、不携带 UI 文案。 */
export type AgentRunClientStatus =
  | { readonly state: "connecting" }
  | { readonly state: "connected" }
  | { readonly state: "disconnected" }
  | { readonly state: "cancelling" };

/** 共享客户端对外回调：已校验归属、按 sequence 去重后的领域事件与连接状态。 */
export interface AgentRunClientCallbacks {
  /** 收到一条属于本 run 的、sequence 严格递增的 AgentEvent。 */
  onEvent(event: AgentEvent): void;
  /** 连接生命周期变化；CLI 可忽略，TUI 据此更新状态栏。 */
  onStatus(status: AgentRunClientStatus): void;
  /** 会话级压缩进度有独立 cursor；不伪造 run 身份。 */
  onCompaction?(event: SessionCompactionEvent): void;
  /** 审批投影变化或重新附着时通知前端；不能阻塞事件接收。 */
  onPermissions?(permissions: readonly ClientPermission[]): void;
}

/**
 * run 生命周期完成方式：
 * - finished：收到 run.finished，前端从事件流自取终态；
 * - cancelled：用户取消且等待超时，或取消发生在 run 建立前；
 * - connect-failed：run 建立前耗尽初始连接尝试；
 * - request-error：Core 明确返回 JSON-RPC error，保留安全错误码和消息；
 * - acceptance-uncertain：agent.run 响应丢失，无法确认是否已建立 run；
 * - internal-error：未预期的内部错误。
 */
export type AgentRunClientResult =
  | { readonly kind: "finished" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "connect-failed" }
  | { readonly kind: "request-error"; readonly code: number; readonly message: string }
  | { readonly kind: "acceptance-uncertain" }
  | { readonly kind: "internal-error" };

/** 供测试注入的连接工厂。 */
export type AgentRunConnector = (endpoint: CoreEndpoint) => Promise<NdjsonRpcConnection>;

export interface AgentRunClientOptions {
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  /** Ctrl-C 取消信号；abort 时向 core 发 agent.cancel。 */
  readonly signal?: AbortSignal;
  /** 连接工厂，默认走真实 TCP；测试注入 fake。 */
  readonly connect?: AgentRunConnector;
  /** 断线重连间隔毫秒数。 */
  readonly reconnectDelayMs?: number;
  /** 首次建立 run 前连接失败的最大重试次数；Infinity 表示无限重试（TUI）。 */
  readonly initialConnectAttempts?: number;
  /** 取消后等待 run.finished(cancelled) 的兜底超时毫秒数。 */
  readonly cancelTimeoutMs?: number;
}

type DrainResult = "finished" | "disconnected";

/**
 * 可被一个或多个 AbortSignal 中断的延时，并在任一路径释放 timer/listener。
 * 取消后的既有 run 重连不会监听用户 signal，只监听显式 shutdown。
 */
function sleepInterruptible(ms: number, signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    for (const signal of signals) {
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}

const SHUTDOWN = Symbol("agent-run-client-shutdown");
const USER_ABORT = Symbol("agent-run-client-user-abort");
const CANCEL_EXPIRED = Symbol("agent-run-client-cancel-expired");

/**
 * 前端共享的 Agent run 控制器：连接 core、启动精确 run、消费事件流，
 * 处理取消与断线 cursor 重连。只负责传输/归属/去重，不生成任何终端文案。
 */
export class AgentRunClient {
  #shutdownController = new AbortController();
  #connections = new Set<NdjsonRpcConnection>();
  #closedConnections = new WeakSet<NdjsonRpcConnection>();
  #permissions = new PermissionState();
  #attached: { connection: NdjsonRpcConnection; identity: RunIdentity } | undefined;
  #onPermissions: AgentRunClientCallbacks["onPermissions"];

  /** 当前 run 的审批快照，决策以 Core journal 为准。 */
  get permissions(): readonly ClientPermission[] {
    return this.#permissions.snapshot;
  }

  /** 仅通过已附着的连接响应审批；发送失败关闭旧连接，交由 run 流程重连。 */
  async respondPermission(
    id: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<PermissionRespondResult> {
    const attached = this.#attached;
    if (attached === undefined || attached.connection.closed)
      throw new Error("run is not connected");
    const params = PermissionRespondParamsSchema.parse({
      ...attached.identity,
      permissionRequestId: id,
      decision,
    });
    const entry = this.permissions.find(
      (entry) => entry.request.payload.permissionRequestId === id,
    );
    if (entry !== undefined && !entry.request.payload.cacheable && decision.startsWith("always_"))
      throw new Error("always decisions are unavailable for this request");
    try {
      const response = await attached.connection.request(
        PERMISSION_RESPOND_METHOD,
        params,
        PermissionRespondResultSchema,
      );
      const result = PermissionRespondResultSchema.parse(response.result);
      if (result.outcome !== "accepted" && this.#permissions.close(id))
        this.#onPermissions?.(this.permissions);
      return result;
    } catch (error) {
      attached.connection.close();
      throw error;
    }
  }

  /**
   * 显式停止客户端：中断连接/重连等待并关闭当前 socket。
   * 方法幂等；一个实例 shutdown 后不可再次执行 run。
   */
  shutdown(): void {
    if (!this.#shutdownController.signal.aborted) {
      this.#shutdownController.abort();
    }
    for (const connection of this.#connections) {
      this.#closeConnection(connection);
    }
    this.#attached = undefined;
    if (this.#permissions.close()) this.#onPermissions?.(this.permissions);
  }

  /** 只关闭一次连接，避免 shutdown 与 run finally 重复释放同一 socket。 */
  #closeConnection(connection: NdjsonRpcConnection): void {
    if (this.#closedConnections.has(connection)) {
      return;
    }
    this.#closedConnections.add(connection);
    connection.close();
    this.#connections.delete(connection);
  }

  /**
   * 执行一次 run，把去重后的领域事件回调给前端，直到终态或错误。
   * 返回值是生命周期完成方式；run 终态（status/reason）由前端从事件推导。
   */
  async run(
    options: AgentRunClientOptions,
    callbacks: AgentRunClientCallbacks,
  ): Promise<AgentRunClientResult> {
    const connect: AgentRunConnector =
      options.connect ?? ((endpoint) => NdjsonRpcConnection.connect(endpoint));
    const signal = options.signal;
    const shutdownSignal = this.#shutdownController.signal;
    const reconnectDelayMs = options.reconnectDelayMs ?? 100;
    const initialConnectAttempts = options.initialConnectAttempts ?? 3;
    const cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000;
    this.#permissions.clear();
    this.#onPermissions = callbacks.onPermissions;

    let lastSequence = 0;
    let lastSessionSequence = 0;
    let cancelledByUser = false;
    let finished = false;
    let runIdentity: RunIdentity | undefined;
    let currentConnection: NdjsonRpcConnection | undefined;
    let cancelDeadline: number | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const userAbortRequested = Promise.withResolvers<void>();
    const cancelExpired = Promise.withResolvers<void>();
    const shutdownRequested = Promise.withResolvers<void>();
    const onShutdown = (): void => shutdownRequested.resolve();
    if (shutdownSignal.aborted) {
      onShutdown();
    } else {
      shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    }
    const shutdownInterruption: Promise<typeof SHUTDOWN> = shutdownRequested.promise.then(
      (): typeof SHUTDOWN => SHUTDOWN,
    );
    const userAbortInterruption: Promise<typeof USER_ABORT> = userAbortRequested.promise.then(
      (): typeof USER_ABORT => USER_ABORT,
    );
    const cancelExpiredInterruption: Promise<typeof CANCEL_EXPIRED> = cancelExpired.promise.then(
      (): typeof CANCEL_EXPIRED => CANCEL_EXPIRED,
    );

    /** 等待下一次重连；取消后仍按节奏重试，但不超过 cancel deadline。 */
    const waitBeforeReconnect = async (): Promise<void> => {
      const remaining = Math.max(0, (cancelDeadline ?? Date.now() + reconnectDelayMs) - Date.now());
      const delay = cancelledByUser ? Math.min(reconnectDelayMs, remaining) : reconnectDelayMs;
      await sleepInterruptible(
        delay,
        cancelledByUser
          ? [shutdownSignal]
          : [shutdownSignal, ...(signal === undefined ? [] : [signal])],
      );
    };

    /** 向当前连接发幂等 cancel；断线时静默失败，由重连逻辑补发。 */
    const requestCancel = async (): Promise<void> => {
      if (runIdentity === undefined || currentConnection === undefined) {
        return;
      }
      try {
        await currentConnection.request(
          AGENT_CANCEL_METHOD,
          { sessionId: runIdentity.sessionId, runId: runIdentity.runId },
          AgentCancelResultSchema,
        );
      } catch {
        // 断线时 cancel 失败；重连后由 drain 继续等待 finished，或再次触发 cancel。
      }
    };

    /** Ctrl-C 触发：请求取消并设置等待终态的兜底超时。 */
    const onAbort = (): void => {
      if (cancelledByUser) {
        return;
      }
      cancelledByUser = true;
      if (this.#permissions.close()) callbacks.onPermissions?.(this.permissions);
      cancelDeadline = Date.now() + cancelTimeoutMs;
      userAbortRequested.resolve();
      cancelTimer = setTimeout(() => cancelExpired.resolve(), cancelTimeoutMs);
      callbacks.onStatus({ state: "cancelling" });
      void requestCancel();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    /**
     * 在一条连接上消费事件流，直到 run 结束、连接断开或取消兜底超时。
     * 按 subscriptionId 过滤、校验 session/run 归属、按 sequence 去重后回调。
     */
    const drain = (
      connection: NdjsonRpcConnection,
      subscriptionId: SubscriptionId,
    ): Promise<DrainResult> => {
      const runFinished = Promise.withResolvers<void>();
      const consume = async (): Promise<DrainResult> => {
        let stopListening: (() => void) | undefined;
        let stopSessionListening: (() => void) | undefined;
        try {
          stopListening = connection.onNotification((notification) => {
            const parsed = EventPushNotificationSchema.safeParse(notification);
            if (!parsed.success || parsed.data.params.subscriptionId !== subscriptionId) {
              return;
            }
            const pushed = parsed.data.params.event;
            // legacy AgentRunClient 只消费 run 事件；session 事件由 SessionController 处理。
            if (!isAgentEvent(pushed)) {
              return;
            }
            const event = pushed;
            // 防御性校验：事件必须属于本次建立的精确 run，避免错误的 core 串流。
            if (
              runIdentity === undefined ||
              event.sessionId !== runIdentity.sessionId ||
              event.runId !== runIdentity.runId
            ) {
              return;
            }
            // 断线重放或乱序到达时跳过已处理过的 sequence。
            if (event.sequence <= lastSequence) {
              return;
            }
            lastSequence = event.sequence;
            if (this.#permissions.apply(event)) callbacks.onPermissions?.(this.permissions);
            callbacks.onEvent(event);
            if (event.type === "run.finished") {
              finished = true;
              runFinished.resolve();
            }
          });
          if (callbacks.onCompaction !== undefined && runIdentity !== undefined) {
            let sessionSubscriptionId: SubscriptionId | undefined;
            const queued: unknown[] = [];
            const consumeSession = (notification: unknown): void => {
              const parsed = EventPushNotificationSchema.safeParse(notification);
              if (!parsed.success || parsed.data.params.subscriptionId !== sessionSubscriptionId)
                return;
              const event = parsed.data.params.event;
              if (
                !isSessionEvent(event) ||
                event.sessionId !== runIdentity?.sessionId ||
                event.sessionSequence <= lastSessionSequence
              )
                return;
              lastSessionSequence = event.sessionSequence;
              if (
                event.type === "session.compaction_started" ||
                event.type === "session.compaction_finished" ||
                event.type === "session.compaction_failed"
              )
                callbacks.onCompaction?.(event);
            };
            // 先监听再请求订阅，避免摘要进度或 run replay 在响应等待期间丢失。
            stopSessionListening = connection.onNotification((notification) => {
              if (sessionSubscriptionId === undefined) queued.push(notification);
              else consumeSession(notification);
            });
            const pendingSession = connection.request(
              SESSION_SUBSCRIBE_METHOD,
              { sessionId: runIdentity.sessionId, afterSequence: lastSessionSequence },
              SessionSubscribeResultSchema,
            );
            const response = await Promise.race([
              pendingSession,
              shutdownInterruption,
              cancelExpiredInterruption,
            ]);
            if (response === SHUTDOWN || response === CANCEL_EXPIRED) return "disconnected";
            sessionSubscriptionId = response.result.subscriptionId;
            for (const notification of queued) consumeSession(notification);
          }
          // listener 已注册、精确订阅已建立，重连后再次展示未处理审批。
          if (runIdentity !== undefined) this.#attached = { connection, identity: runIdentity };
          callbacks.onPermissions?.(this.permissions);
          await Promise.race([
            runFinished.promise,
            connection.waitUntilClosed(),
            cancelExpired.promise,
            shutdownRequested.promise,
          ]);
          return finished ? "finished" : "disconnected";
        } finally {
          stopListening?.();
          stopSessionListening?.();
        }
      };
      return consume();
    };

    try {
      let connectAttempts = 0;
      for (;;) {
        if (shutdownSignal.aborted) {
          return { kind: "cancelled" };
        }
        if (cancelDeadline !== undefined && Date.now() >= cancelDeadline) {
          return { kind: "cancelled" };
        }
        if (signal?.aborted === true && finished) {
          return { kind: "finished" };
        }
        // run 尚未建立时用户已取消：不再发起连接/run，立即结束。
        if (signal?.aborted === true && runIdentity === undefined) {
          return { kind: "cancelled" };
        }

        callbacks.onStatus({ state: "connecting" });

        let connection: NdjsonRpcConnection;
        try {
          const pendingConnection = connect(options.endpoint);
          const connected = await Promise.race([
            pendingConnection,
            shutdownInterruption,
            ...(runIdentity === undefined ? [userAbortInterruption] : [cancelExpiredInterruption]),
          ]);
          if (connected === SHUTDOWN || connected === USER_ABORT || connected === CANCEL_EXPIRED) {
            // connect 无法从外部取消；若稍后成功，立即关闭迟到的 socket。
            void pendingConnection.then(
              (lateConnection) => this.#closeConnection(lateConnection),
              () => {},
            );
            return { kind: "cancelled" };
          }
          connection = connected;
        } catch {
          if (shutdownSignal.aborted) {
            return { kind: "cancelled" };
          }
          // run 尚未建立：连接失败是配置/环境问题，有限重试后返回 connect-failed。
          if (runIdentity === undefined) {
            connectAttempts += 1;
            if (signal?.aborted === true) {
              return { kind: "cancelled" };
            }
            if (connectAttempts >= initialConnectAttempts) {
              return { kind: "connect-failed" };
            }
          }
          // 已建立 run 且用户取消时仍需重连补发 cancel，直到终态或 deadline。
          callbacks.onStatus({ state: "disconnected" });
          await waitBeforeReconnect();
          continue;
        }
        connectAttempts = 0;
        currentConnection = connection;
        this.#connections.add(connection);
        // connect 期间可能发生用户取消或显式 shutdown；不得继续发送 agent.run。
        if (shutdownSignal.aborted || (signal?.aborted === true && runIdentity === undefined)) {
          this.#closeConnection(connection);
          currentConnection = undefined;
          return { kind: "cancelled" };
        }
        callbacks.onStatus({ state: "connected" });

        try {
          let subscriptionId: SubscriptionId;
          if (runIdentity === undefined) {
            const pendingRun = connection.request(
              AGENT_RUN_METHOD,
              { goal: options.goal, workspaceRoot: options.workspaceRoot },
              AgentRunResultSchema,
            );
            const response = await Promise.race([pendingRun, shutdownInterruption]);
            if (response === SHUTDOWN) {
              return { kind: "cancelled" };
            }
            runIdentity = {
              sessionId: response.result.sessionId,
              runId: response.result.runId,
            };
            subscriptionId = response.result.subscriptionId;
            // Ctrl-C 可能发生在 run 建立之前，run 建立后补发 cancel。
            if (cancelledByUser) {
              void requestCancel();
            }
          } else {
            // 断线重连：用已处理 cursor 续订，重放 durable 事件并去重。
            const pendingSubscribe = connection.request(
              EVENT_SUBSCRIBE_METHOD,
              {
                sessionId: runIdentity.sessionId,
                runId: runIdentity.runId,
                afterSequence: lastSequence,
              },
              EventSubscribeResultSchema,
            );
            const response = await Promise.race([
              pendingSubscribe,
              shutdownInterruption,
              cancelExpiredInterruption,
            ]);
            if (response === SHUTDOWN || response === CANCEL_EXPIRED) {
              return { kind: "cancelled" };
            }
            subscriptionId = response.result.subscriptionId;
            // Ctrl-C 可能发生在断线期间；每次重连后幂等补发取消请求。
            if (cancelledByUser) {
              // 不等待响应，确保 replay notification 到达前 drain 已注册 listener。
              void requestCancel();
            }
          }

          const status = await drain(connection, subscriptionId);
          if (status === "finished") {
            return { kind: "finished" };
          }
          // 连接断开：run 未结束时进入重连循环。
        } catch (error) {
          // request 或 drain 异常：run 已结束则直接结束，否则当作断线重连。
          if (finished) {
            return { kind: "finished" };
          }
          if (runIdentity === undefined) {
            // 已收到 JSON-RPC error 时请求结果是确定的，不能误报为响应丢失。
            if (error instanceof RpcClientError && error.code !== undefined) {
              return { kind: "request-error", code: error.code, message: error.message };
            }
            // agent.run 的响应可能在 accepted 后丢失；禁止重试创建，避免产生重复的孤儿 run。
            return cancelledByUser ? { kind: "cancelled" } : { kind: "acceptance-uncertain" };
          }
        } finally {
          this.#attached = undefined;
          this.#closeConnection(connection);
          currentConnection = undefined;
        }

        callbacks.onStatus({ state: "disconnected" });

        if (cancelDeadline !== undefined && Date.now() >= cancelDeadline) {
          return { kind: "cancelled" };
        }
        await waitBeforeReconnect();
      }
    } catch {
      // 任何未预期的内部错误都不向上抛。
      return { kind: "internal-error" };
    } finally {
      this.#attached = undefined;
      if (this.#permissions.close()) callbacks.onPermissions?.(this.permissions);
      this.#onPermissions = undefined;
      if (cancelTimer !== undefined) {
        clearTimeout(cancelTimer);
      }
      shutdownSignal.removeEventListener("abort", onShutdown);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
