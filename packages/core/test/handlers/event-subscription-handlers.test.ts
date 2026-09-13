import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { IpcEventBroadcaster } from "../../src/events/ipc-event-broadcaster.ts";
import {
  EventSubscribeHandler,
  EventUnsubscribeHandler,
} from "../../src/handlers/event-subscription-handlers.ts";
import type { RpcConnection, RpcInvocationContext } from "../../src/index.ts";
import { MemoryJournalStorage, RUN_A, SESSION_A } from "../events/test-helpers.ts";

function createContext(id = "connection-1"): RpcInvocationContext {
  const connection: RpcConnection = {
    id,
    closed: new Promise<void>(() => {}),
    sendNotification: () => true,
  };
  return { connection };
}

function createHandlers(storage = new MemoryJournalStorage()) {
  const bus = new EventBus(new EventStore("/memory", storage));
  const broadcaster = new IpcEventBroadcaster(bus);
  return {
    broadcaster,
    subscribe: new EventSubscribeHandler(broadcaster),
    unsubscribe: new EventUnsubscribeHandler(broadcaster),
  };
}

describe("event subscription RPC handlers", () => {
  test("validates subscribe params and returns a deferred activation", async () => {
    const handlers = createHandlers();
    const context = createContext();
    expect(await handlers.subscribe.invoke({}, context)).toEqual({ kind: "invalid-params" });

    const result = await handlers.subscribe.invoke({ sessionId: SESSION_A, runId: RUN_A }, context);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      return;
    }
    expect(result.result).toEqual({
      subscriptionId: expect.any(String),
      sessionId: SESSION_A,
      runId: RUN_A,
    });
    expect(typeof result.afterResponseEnqueued).toBe("function");
  });

  test("only lets the owning connection unsubscribe", async () => {
    const handlers = createHandlers();
    const owner = createContext("owner");
    const subscribed = await handlers.subscribe.invoke(
      { sessionId: SESSION_A, runId: RUN_A },
      owner,
    );
    expect(subscribed.kind).toBe("success");
    if (subscribed.kind !== "success") {
      return;
    }
    const subscriptionId = (subscribed.result as { subscriptionId: string }).subscriptionId;

    expect(
      await handlers.unsubscribe.invoke({ subscriptionId }, createContext("stranger")),
    ).toEqual({ kind: "success", result: { removed: false } });
    expect(await handlers.unsubscribe.invoke({ subscriptionId }, owner)).toEqual({
      kind: "success",
      result: { removed: true },
    });
  });

  test("propagates a typed store failure to the dispatcher boundary", async () => {
    const storage = new MemoryJournalStorage();
    storage.readError = new Error("private detail");
    const handlers = createHandlers(storage);

    await expect(
      handlers.subscribe.invoke({ sessionId: SESSION_A, runId: RUN_A }, createContext()),
    ).rejects.toThrow("event_store_error");
  });
});
