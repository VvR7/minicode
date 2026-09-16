import type {
  EventSubscribeResult,
  EventUnsubscribeResult,
  RunId,
  SessionId,
  SubscriptionId,
} from "@minicode/protocol";
import { EVENT_PUSH_METHOD } from "@minicode/protocol";
import type { RpcConnection } from "../rpc-context.ts";
import type { RunTraceRegistry } from "../trace/registry.ts";
import type { EventBus, EventBusResult, EventSubscription } from "./event-bus.ts";

interface OwnedSubscription {
  readonly connectionId: string;
  readonly subscription: EventSubscription;
}

export interface IpcEventSubscription {
  readonly result: EventSubscribeResult;
  readonly afterResponseEnqueued: () => void;
  /** 订阅关闭时完成；用于释放等待 response 入队的 run，但不隐式取消它。 */
  readonly closed: Promise<unknown>;
}

/** 把一个 run 的 EventBus 事件转换成同连接上的 event.push notification。 */
export class IpcEventBroadcaster {
  readonly #bus: EventBus;
  readonly #traces: RunTraceRegistry | undefined;
  readonly #subscriptions = new Map<SubscriptionId, OwnedSubscription>();
  readonly #connectionSubscriptions = new Map<string, Set<SubscriptionId>>();
  readonly #watchedConnections = new Set<string>();

  constructor(bus: EventBus, traces?: RunTraceRegistry) {
    this.#bus = bus;
    this.#traces = traces;
  }

  async subscribe(
    connection: RpcConnection,
    sessionId: SessionId,
    runId: RunId,
    afterSequence = 0,
  ): Promise<EventBusResult<IpcEventSubscription>> {
    const subscriptionId = crypto.randomUUID();
    const created = await this.#bus.subscribe(
      sessionId,
      runId,
      async (event) => {
        const notification = {
          jsonrpc: "2.0",
          method: EVENT_PUSH_METHOD,
          params: { subscriptionId, event },
        } as const;
        const sending = connection.sendNotification(notification);
        const trace = this.#traces?.get(sessionId, runId);
        trace?.record({
          source: "CORE",
          target: "CLIENT",
          kind: "ipc.response_queued",
          connectionId: connection.id,
          requestId: subscriptionId,
          data: { method: EVENT_PUSH_METHOD, eventType: event.type, sequence: event.sequence },
        });
        const sent = await sending;
        trace?.record({
          source: "CORE",
          target: "CLIENT",
          kind: sent ? "ipc.response_sent" : "ipc.error",
          connectionId: connection.id,
          requestId: subscriptionId,
          data: { method: EVENT_PUSH_METHOD, eventType: event.type, sequence: event.sequence },
        });
        if (!sent) {
          throw new Error("IPC connection cannot accept another event");
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
      subscription: created.value,
    });
    let ids = this.#connectionSubscriptions.get(connection.id);
    if (ids === undefined) {
      ids = new Set();
      this.#connectionSubscriptions.set(connection.id, ids);
    }
    ids.add(subscriptionId);
    void created.value.closed.then((reason) => {
      this.#forget(subscriptionId);
      if (reason === "slow_consumer" || reason === "handler_error") {
        connection.disconnect();
      }
    });
    this.#watchConnection(connection);
    return {
      ok: true,
      value: {
        result: { subscriptionId, sessionId, runId },
        afterResponseEnqueued: () => created.value.activate(),
        closed: created.value.closed,
      },
    };
  }

  unsubscribe(connection: RpcConnection, subscriptionId: SubscriptionId): EventUnsubscribeResult {
    const owned = this.#subscriptions.get(subscriptionId);
    if (owned === undefined || owned.connectionId !== connection.id) {
      return { removed: false };
    }
    owned.subscription.dispose();
    this.#forget(subscriptionId);
    return { removed: true };
  }

  close(): void {
    for (const owned of this.#subscriptions.values()) {
      owned.subscription.dispose();
    }
    this.#subscriptions.clear();
    this.#connectionSubscriptions.clear();
    this.#watchedConnections.clear();
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  /** 判断连接是否仍订阅指定 run，作为审批响应的附着凭证。 */
  isAttached(connection: RpcConnection, sessionId: SessionId, runId: RunId): boolean {
    return [...this.#subscriptions.values()].some(
      (owned) =>
        owned.connectionId === connection.id &&
        owned.subscription.sessionId === sessionId &&
        owned.subscription.runId === runId,
    );
  }

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
