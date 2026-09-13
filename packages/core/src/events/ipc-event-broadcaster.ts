import type {
  EventSubscribeResult,
  EventUnsubscribeResult,
  RunId,
  SessionId,
  SubscriptionId,
} from "@minicode/protocol";
import { EVENT_PUSH_METHOD } from "@minicode/protocol";
import type { RpcConnection } from "../rpc-context.ts";
import type { EventBus, EventBusResult, EventSubscription } from "./event-bus.ts";

interface OwnedSubscription {
  readonly connectionId: string;
  readonly subscription: EventSubscription;
}

export interface IpcEventSubscription {
  readonly result: EventSubscribeResult;
  readonly afterResponseEnqueued: () => void;
}

/** 把一个 run 的 EventBus 事件转换成同连接上的 event.push notification。 */
export class IpcEventBroadcaster {
  readonly #bus: EventBus;
  readonly #subscriptions = new Map<SubscriptionId, OwnedSubscription>();
  readonly #connectionSubscriptions = new Map<string, Set<SubscriptionId>>();
  readonly #watchedConnections = new Set<string>();

  constructor(bus: EventBus) {
    this.#bus = bus;
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
      (event) => {
        const sent = connection.sendNotification({
          jsonrpc: "2.0",
          method: EVENT_PUSH_METHOD,
          params: { subscriptionId, event },
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
    void created.value.closed.then(() => this.#forget(subscriptionId));
    this.#watchConnection(connection);
    return {
      ok: true,
      value: {
        result: { subscriptionId, sessionId, runId },
        afterResponseEnqueued: () => created.value.activate(),
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
