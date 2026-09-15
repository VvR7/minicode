import type {
  EventUnsubscribeResult,
  SessionId,
  SessionSubscribeResult,
  SubscriptionId,
} from "@minicode/protocol";
import { EVENT_PUSH_METHOD } from "@minicode/protocol";
import type { RpcConnection } from "../rpc-context.ts";
import type { RunTraceRegistry } from "../trace/registry.ts";
import type {
  SessionEventBus,
  SessionEventBusResult,
  SessionEventSubscription,
} from "./session-event-bus.ts";

interface OwnedSessionSubscription {
  readonly connectionId: string;
  readonly subscription: SessionEventSubscription;
}

export interface IpcSessionSubscription {
  readonly result: SessionSubscribeResult;
  readonly afterResponseEnqueued: () => void;
  readonly closed: Promise<unknown>;
}

/** 将单个 session 的 replay/live 事件转换为所属连接上的 event.push。 */
export class IpcSessionBroadcaster {
  readonly #bus: SessionEventBus;
  readonly #traces: RunTraceRegistry | undefined;
  readonly #subscriptions = new Map<SubscriptionId, OwnedSessionSubscription>();
  readonly #connectionSubscriptions = new Map<string, Set<SubscriptionId>>();
  readonly #watchedConnections = new Set<string>();

  constructor(bus: SessionEventBus, traces?: RunTraceRegistry) {
    this.#bus = bus;
    this.#traces = traces;
  }

  /** 创建暂停的 session 订阅，响应入队后再激活推送。 */
  async subscribe(
    connection: RpcConnection,
    sessionId: SessionId,
    afterSequence = 0,
  ): Promise<SessionEventBusResult<IpcSessionSubscription>> {
    const subscriptionId = crypto.randomUUID();
    const created = await this.#bus.subscribe(
      sessionId,
      async (event) => {
        const notification = {
          jsonrpc: "2.0",
          method: EVENT_PUSH_METHOD,
          params: { subscriptionId, event },
        } as const;
        const sending = connection.sendNotification(notification);
        const runId = event.payload.runId;
        const trace = this.#traces?.get(sessionId, runId);
        trace?.record({
          source: "CORE",
          target: "CLIENT",
          kind: "ipc.response_queued",
          connectionId: connection.id,
          requestId: subscriptionId,
          data: {
            method: EVENT_PUSH_METHOD,
            eventType: event.type,
            sessionSequence: event.sessionSequence,
          },
        });
        const sent = await sending;
        trace?.record({
          source: "CORE",
          target: "CLIENT",
          kind: sent ? "ipc.response_sent" : "ipc.error",
          connectionId: connection.id,
          requestId: subscriptionId,
          data: {
            method: EVENT_PUSH_METHOD,
            eventType: event.type,
            sessionSequence: event.sessionSequence,
          },
        });
        if (!sent) {
          throw new Error("IPC connection cannot accept another session event");
        }
      },
      afterSequence,
      subscriptionId,
      true,
    );
    if (!created.ok) {
      return created;
    }

    this.#subscriptions.set(subscriptionId, {
      connectionId: connection.id,
      subscription: created.value.subscription,
    });
    let ids = this.#connectionSubscriptions.get(connection.id);
    if (ids === undefined) {
      ids = new Set();
      this.#connectionSubscriptions.set(connection.id, ids);
    }
    ids.add(subscriptionId);
    void created.value.subscription.closed.then((reason) => {
      this.#forget(subscriptionId);
      if (reason === "slow_consumer" || reason === "handler_error") {
        connection.disconnect();
      }
    });
    this.#watchConnection(connection);
    return {
      ok: true,
      value: {
        result: {
          subscriptionId,
          sessionId,
          latestSequence: created.value.latestSequence,
        },
        afterResponseEnqueued: () => created.value.subscription.activate(),
        closed: created.value.subscription.closed,
      },
    };
  }

  /** 仅允许创建订阅的连接释放该 subscriptionId。 */
  unsubscribe(connection: RpcConnection, subscriptionId: SubscriptionId): EventUnsubscribeResult {
    const owned = this.#subscriptions.get(subscriptionId);
    if (owned === undefined || owned.connectionId !== connection.id) {
      return { removed: false };
    }
    owned.subscription.dispose();
    this.#forget(subscriptionId);
    return { removed: true };
  }

  /** Core shutdown 时释放全部 session 订阅。 */
  close(): void {
    for (const owned of this.#subscriptions.values()) {
      owned.subscription.dispose();
    }
    this.#subscriptions.clear();
    this.#connectionSubscriptions.clear();
    this.#watchedConnections.clear();
  }

  /** 返回当前拥有的 session 订阅总数。 */
  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  /** 首次订阅时监听连接关闭并释放该连接的全部 session 订阅。 */
  #watchConnection(connection: RpcConnection): void {
    if (this.#watchedConnections.has(connection.id)) {
      return;
    }
    this.#watchedConnections.add(connection.id);
    void connection.closed.then(() => {
      const ids = this.#connectionSubscriptions.get(connection.id);
      if (ids !== undefined) {
        for (const id of [...ids]) {
          this.#subscriptions.get(id)?.subscription.dispose();
          this.#forget(id);
        }
      }
      this.#watchedConnections.delete(connection.id);
    });
  }

  /** 从订阅表和 connection 反向索引中同时移除。 */
  #forget(subscriptionId: SubscriptionId): void {
    const owned = this.#subscriptions.get(subscriptionId);
    if (owned === undefined) {
      return;
    }
    this.#subscriptions.delete(subscriptionId);
    const ids = this.#connectionSubscriptions.get(owned.connectionId);
    ids?.delete(subscriptionId);
    if (ids?.size === 0) {
      this.#connectionSubscriptions.delete(owned.connectionId);
    }
  }
}
