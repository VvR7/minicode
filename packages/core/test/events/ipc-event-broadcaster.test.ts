import { describe, expect, test } from "bun:test";

import type { JsonRpcNotificationEnvelope } from "@minicode/protocol";
import { EventPushNotificationSchema } from "@minicode/protocol";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { IpcEventBroadcaster } from "../../src/events/ipc-event-broadcaster.ts";
import type { RpcConnection } from "../../src/rpc-context.ts";
import { MemoryJournalStorage, RUN_A, SESSION_A, startedInput } from "./test-helpers.ts";

interface MockConnection extends RpcConnection {
  readonly notifications: JsonRpcNotificationEnvelope[];
  close(): void;
}

function createConnection(id: string, sendResult = true): MockConnection {
  const closed = Promise.withResolvers<void>();
  const notifications: JsonRpcNotificationEnvelope[] = [];
  return {
    id,
    closed: closed.promise,
    notifications,
    sendNotification(notification) {
      notifications.push(notification);
      return sendResult;
    },
    close: () => closed.resolve(),
  };
}

function createBroadcaster() {
  const bus = new EventBus(new EventStore("/memory", new MemoryJournalStorage()));
  return { bus, broadcaster: new IpcEventBroadcaster(bus) };
}

describe("IpcEventBroadcaster", () => {
  test("holds replay until the RPC response has been enqueued", async () => {
    const { bus, broadcaster } = createBroadcaster();
    await bus.publish(startedInput());
    const connection = createConnection("connection-1");

    const subscribed = await broadcaster.subscribe(connection, SESSION_A, RUN_A);
    expect(subscribed.ok).toBe(true);
    expect(connection.notifications).toEqual([]);
    if (!subscribed.ok) {
      return;
    }
    subscribed.value.afterResponseEnqueued();
    await Promise.resolve();

    expect(connection.notifications).toHaveLength(1);
    expect(connection.notifications[0]?.method).toBe("event.push");
    const notification = EventPushNotificationSchema.parse(connection.notifications[0]);
    expect(notification.params.subscriptionId).toBe(subscribed.value.result.subscriptionId);
  });

  test("enforces subscription ownership and cleans up on connection close", async () => {
    const { broadcaster } = createBroadcaster();
    const owner = createConnection("owner");
    const stranger = createConnection("stranger");
    const first = await broadcaster.subscribe(owner, SESSION_A, RUN_A);
    const second = await broadcaster.subscribe(owner, SESSION_A, RUN_A);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    expect(broadcaster.unsubscribe(stranger, first.value.result.subscriptionId)).toEqual({
      removed: false,
    });
    expect(broadcaster.unsubscribe(owner, first.value.result.subscriptionId)).toEqual({
      removed: true,
    });
    expect(broadcaster.subscriptionCount).toBe(1);
    owner.close();
    await Promise.resolve();
    expect(broadcaster.subscriptionCount).toBe(0);
  });

  test("drops a subscription when the IPC connection rejects an event", async () => {
    const { bus, broadcaster } = createBroadcaster();
    const connection = createConnection("slow", false);
    const subscribed = await broadcaster.subscribe(connection, SESSION_A, RUN_A);
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) {
      return;
    }
    subscribed.value.afterResponseEnqueued();
    await bus.publish(startedInput());
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.notifications).toHaveLength(1);
    expect(broadcaster.subscriptionCount).toBe(0);
  });

  test("close disposes every owned subscription", async () => {
    const { broadcaster } = createBroadcaster();
    const connection = createConnection("connection-1");
    await broadcaster.subscribe(connection, SESSION_A, RUN_A);
    await broadcaster.subscribe(connection, SESSION_A, RUN_A);
    expect(broadcaster.subscriptionCount).toBe(2);

    broadcaster.close();
    expect(broadcaster.subscriptionCount).toBe(0);
  });
});
