import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RpcInvocationContext } from "../../packages/core/src/index.ts";
import {
  CoreApp,
  createRpcDispatcher,
  NdjsonRpcConnection,
  NdjsonRpcServer,
  RpcMethodHandler,
} from "../../packages/core/src/index.ts";
import type { EventPushNotification } from "../../packages/protocol/src/index.ts";
import {
  AGENT_RUN_METHOD,
  AgentRunResultSchema,
  EVENT_SUBSCRIBE_METHOD,
  EVENT_UNSUBSCRIBE_METHOD,
  EventPushNotificationSchema,
  EventSubscribeResultSchema,
  EventUnsubscribeResultSchema,
} from "../../packages/protocol/src/index.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const subscriptionId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class RunHandler extends RpcMethodHandler {
  readonly method = AGENT_RUN_METHOD;

  async invoke(_params: unknown, context: RpcInvocationContext) {
    return {
      kind: "success" as const,
      result: { status: "accepted", sessionId, runId, subscriptionId },
      afterResponseEnqueued: () => {
        context.connection.sendNotification({
          jsonrpc: "2.0",
          method: "event.push",
          params: {
            subscriptionId,
            event: {
              sessionId,
              runId,
              sequence: 1,
              timestamp: "2026-09-13T08:00:00.000Z",
              durable: true,
              type: "run.started",
              payload: {},
            },
          },
        });
      },
    };
  }
}

describe("typed IPC event stream", () => {
  test("carries an agent response and typed event on one persistent connection", async () => {
    const server = new NdjsonRpcServer(
      { host: "127.0.0.1", port: 0 },
      createRpcDispatcher({ handlers: [new RunHandler()] }),
      silentLogger,
    );
    const endpoint = server.start();
    const connection = await NdjsonRpcConnection.connect(endpoint);
    const eventReceived = Promise.withResolvers<EventPushNotification>();
    let unsubscribe = (): void => {};

    try {
      const response = await connection.request(
        AGENT_RUN_METHOD,
        { goal: "总结 README", workspaceRoot: "/workspace" },
        AgentRunResultSchema,
        { requestId: "run-request" },
      );
      unsubscribe = connection.onNotification((notification) => {
        const parsed = EventPushNotificationSchema.safeParse(notification);
        if (parsed.success) {
          eventReceived.resolve(parsed.data);
        }
      });
      const notification = await eventReceived.promise;

      expect(response.result).toEqual({ status: "accepted", sessionId, runId, subscriptionId });
      expect(notification.params.event.type).toBe("run.started");
      expect(notification.params.event.sequence).toBe(1);
    } finally {
      unsubscribe();
      connection.close();
      await server.stop(100);
    }
  });

  test("subscribes, publishes, and unsubscribes through the composed CoreApp", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-ipc-events-"));
    const app = new CoreApp({
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      homeDirectory,
    });
    const connection = await NdjsonRpcConnection.connect(app.start());
    const received = Promise.withResolvers<EventPushNotification>();
    const stopListening = connection.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (parsed.success) {
        received.resolve(parsed.data);
      }
    });

    try {
      const subscribed = await connection.request(
        EVENT_SUBSCRIBE_METHOD,
        { sessionId, runId, afterSequence: 0 },
        EventSubscribeResultSchema,
        { requestId: "subscribe" },
      );
      const published = await app.eventBus.publish({
        sessionId,
        runId,
        timestamp: "2026-09-13T08:00:00.000Z",
        durable: true,
        type: "run.started",
        payload: {},
      });
      const notification = await received.promise;
      expect(published.ok).toBe(true);
      expect(notification.params.subscriptionId).toBe(subscribed.result.subscriptionId);

      const unsubscribed = await connection.request(
        EVENT_UNSUBSCRIBE_METHOD,
        { subscriptionId: subscribed.result.subscriptionId },
        EventUnsubscribeResultSchema,
        { requestId: "unsubscribe" },
      );
      expect(unsubscribed.result.removed).toBe(true);
    } finally {
      stopListening();
      connection.close();
      await app.stop();
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
