import { afterEach, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import type { CoreEndpoint, RunId } from "@minicode/protocol";
import {
  EVENT_SUBSCRIBE_METHOD,
  JsonRpcErrorCode,
  MAX_JSON_RPC_FRAME_BYTES,
} from "@minicode/protocol";
import { EventBus } from "../src/events/event-bus.ts";
import { EventStore } from "../src/events/event-store.ts";
import { IpcEventBroadcaster } from "../src/events/ipc-event-broadcaster.ts";
import { EventSubscribeHandler } from "../src/handlers/event-subscription-handlers.ts";
import { PingHandler } from "../src/handlers/ping-handler.ts";
import { RpcMethodHandler } from "../src/handlers/rpc-method-handler.ts";
import type { Logger } from "../src/logger.ts";
import type { RpcInvocationContext } from "../src/rpc-context.ts";
import { createRpcDispatcher } from "../src/rpc-dispatcher.ts";
import { NdjsonRpcServer } from "../src/transport/ndjson-server.ts";
import {
  deltaInput,
  MemoryJournalStorage,
  RUN_A,
  RUN_B,
  SESSION_A,
} from "./events/test-helpers.ts";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const runningServers: NdjsonRpcServer[] = [];

function createPingDispatcher() {
  return createRpcDispatcher({
    handlers: [new PingHandler({ uptimeMs: () => 1 })],
  });
}

function startServer(): { readonly server: NdjsonRpcServer; readonly endpoint: CoreEndpoint } {
  const dispatcher = createPingDispatcher();
  const server = new NdjsonRpcServer({ host: "127.0.0.1", port: 0 }, dispatcher, silentLogger);
  const endpoint = server.start();
  runningServers.push(server);
  return { server, endpoint };
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop(100)));
});

function exchange(
  endpoint: CoreEndpoint,
  payload: string | Uint8Array | readonly (string | Uint8Array)[],
  expectedLines: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    const lines: string[] = [];
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("test exchange timed out")), 2_000);

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(lines);
      }
    };

    socket.on("connect", () => {
      if (typeof payload === "string" || payload instanceof Uint8Array) {
        socket.write(payload);
        return;
      }
      payload.forEach((part, index) => {
        setTimeout(() => socket.write(part), index * 5);
      });
    });
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex === -1) {
          return;
        }
        lines.push(buffer.subarray(0, newlineIndex).toString("utf8"));
        buffer = buffer.subarray(newlineIndex + 1);
        if (lines.length === expectedLines) {
          finish();
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled && lines.length < expectedLines) {
        finish(new Error(`connection closed after ${lines.length} responses`));
      }
    });
  });
}

function pingFrame(id: string | number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "core.ping",
    params: { clientName: "test", clientVersion: "0.0.1" },
  })}\n`;
}

describe("NDJSON RPC server", () => {
  test("reassembles a request split across socket reads", async () => {
    const { endpoint } = startServer();
    const frame = pingFrame("fragmented");
    const midpoint = Math.floor(frame.length / 2);
    const response = await exchange(endpoint, [frame.slice(0, midpoint), frame.slice(midpoint)], 1);

    expect(JSON.parse(response[0] ?? "null").id).toBe("fragmented");
  });

  test("handles multiple frames serially and preserves IDs", async () => {
    const { endpoint } = startServer();
    const responses = await exchange(endpoint, `${pingFrame("first")}${pingFrame(2)}`, 2);

    expect(responses.map((line) => JSON.parse(line).id)).toEqual(["first", 2]);
  });

  test("serves separate connections concurrently", async () => {
    const { endpoint } = startServer();
    const [first, second] = await Promise.all([
      exchange(endpoint, pingFrame("first"), 1),
      exchange(endpoint, pingFrame("second"), 1),
    ]);

    expect(JSON.parse(first[0] ?? "null").id).toBe("first");
    expect(JSON.parse(second[0] ?? "null").id).toBe("second");
  });

  test("maps parse, request, method, and params failures to standard codes", async () => {
    const { endpoint } = startServer();
    const payload = [
      "not json\n",
      "[]\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: "method", method: "unknown", params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: "params", method: "core.ping", params: {} })}\n`,
    ].join("");
    const responses = await exchange(endpoint, payload, 4);
    const codes = responses.map((line) => JSON.parse(line).error.code);

    expect(codes).toEqual([
      JsonRpcErrorCode.parseError,
      JsonRpcErrorCode.invalidRequest,
      JsonRpcErrorCode.methodNotFound,
      JsonRpcErrorCode.invalidParams,
    ]);
  });

  test("rejects invalid UTF-8 and accepts CRLF framing", async () => {
    const { endpoint } = startServer();
    const invalidUtf8 = await exchange(endpoint, new Uint8Array([0xff, 0x0a]), 1);
    const crlf = await exchange(endpoint, pingFrame("crlf").replace("\n", "\r\n"), 1);

    expect(JSON.parse(invalidUtf8[0] ?? "null").error.code).toBe(JsonRpcErrorCode.parseError);
    expect(JSON.parse(crlf[0] ?? "null").id).toBe("crlf");
  });

  test("hides unexpected handler failures", async () => {
    const server = new NdjsonRpcServer(
      { host: "127.0.0.1", port: 0 },
      async () => {
        throw new Error("sensitive details");
      },
      silentLogger,
    );
    const endpoint = server.start();
    runningServers.push(server);
    const response = JSON.parse((await exchange(endpoint, pingFrame("failure"), 1))[0] ?? "null");

    expect(response.error).toEqual({
      code: JsonRpcErrorCode.internalError,
      message: "Internal error",
    });
  });

  test("queues the RPC response before an after-response notification", async () => {
    class EventHandler extends RpcMethodHandler {
      readonly method = "test.subscribe";

      async invoke(_params: unknown, context: RpcInvocationContext) {
        return {
          kind: "success" as const,
          result: { subscriptionId: "subscription-1" },
          afterResponseEnqueued: () => {
            context.connection.sendNotification({
              jsonrpc: "2.0",
              method: "test.event",
              params: { sequence: 1 },
            });
          },
        };
      }
    }

    const server = new NdjsonRpcServer(
      { host: "127.0.0.1", port: 0 },
      createRpcDispatcher({ handlers: [new EventHandler()] }),
      silentLogger,
    );
    const endpoint = server.start();
    runningServers.push(server);
    const frames = await exchange(
      endpoint,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "subscribe-1",
        method: "test.subscribe",
        params: {},
      })}\n`,
      2,
    );

    expect(JSON.parse(frames[0] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: "subscribe-1",
      result: { subscriptionId: "subscription-1" },
    });
    expect(JSON.parse(frames[1] ?? "null")).toEqual({
      jsonrpc: "2.0",
      method: "test.event",
      params: { sequence: 1 },
    });
  });

  test("rejects notifications, unknown fields, and empty frames", async () => {
    const { endpoint } = startServer();
    const payload = [
      `${JSON.stringify({ jsonrpc: "2.0", method: "core.ping", params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: "extra", method: "core.ping", params: {}, extra: true })}\n`,
      "\n",
    ].join("");
    const responses = await exchange(endpoint, payload, 3);

    expect(responses.map((line) => JSON.parse(line).error.code)).toEqual([
      JsonRpcErrorCode.invalidRequest,
      JsonRpcErrorCode.invalidRequest,
      JsonRpcErrorCode.parseError,
    ]);
  });

  test("rejects an oversized frame and closes the connection", async () => {
    const { endpoint } = startServer();
    const response = await exchange(endpoint, `${"x".repeat(MAX_JSON_RPC_FRAME_BYTES + 1)}\n`, 1);
    const parsed = JSON.parse(response[0] ?? "null");

    expect(parsed.error.code).toBe(JsonRpcErrorCode.invalidRequest);
    expect(parsed.error.message).toBe("Request too large");
  });

  test("fails when another server already owns the endpoint", () => {
    const { endpoint } = startServer();
    const second = new NdjsonRpcServer(endpoint, createPingDispatcher(), silentLogger);

    expect(() => second.start()).toThrow();
  });

  test("rejects restart until an in-flight stop has fully closed connections", async () => {
    const { server, endpoint } = startServer();
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const stopping = server.stop(100);
    expect(() => server.start()).toThrow("server already started");
    await stopping;

    const restarted = server.start();
    expect(restarted.port).toBeGreaterThan(0);
    socket.destroy();
  });

  test("bounded shutdown closes an idle active connection", async () => {
    const { server, endpoint } = startServer();
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    await server.stop(100);
    await closed;

    expect(socket.destroyed).toBe(true);
  });

  test("disconnects a stopped-reading event client without delaying a healthy client", async () => {
    const bus = new EventBus(new EventStore("/memory", new MemoryJournalStorage()));
    const broadcaster = new IpcEventBroadcaster(bus);
    const server = new NdjsonRpcServer(
      { host: "127.0.0.1", port: 0 },
      createRpcDispatcher({ handlers: [new EventSubscribeHandler(broadcaster)] }),
      silentLogger,
    );
    const endpoint = server.start();
    runningServers.push(server);

    const subscribe = (runId: RunId, pauseAfterResponse: boolean) =>
      new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
        const socket = createConnection(endpoint);
        let buffer = Buffer.alloc(0);
        socket.once("error", reject);
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);
          if (buffer.indexOf(0x0a) === -1) return;
          if (pauseAfterResponse) socket.pause();
          resolve(socket);
        });
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: `subscribe-${runId}`,
              method: EVENT_SUBSCRIBE_METHOD,
              params: { sessionId: SESSION_A, runId, afterSequence: 0 },
            })}\n`,
          );
        });
      });

    const [slowSocket, healthySocket] = await Promise.all([
      subscribe(RUN_A, true),
      subscribe(RUN_B, false),
    ]);
    const slowClosed = new Promise<void>((resolve) => slowSocket.once("close", resolve));
    const healthyEvent = new Promise<void>((resolve) =>
      healthySocket.on("data", (data) => {
        if (data.toString("utf8").includes('"method":"event.push"')) resolve();
      }),
    );

    expect((await bus.publish(deltaInput("healthy", RUN_B))).ok).toBe(true);
    await healthyEvent;

    const largeDelta = "x".repeat(16 * 1024);
    for (let index = 0; index < 2_000 && broadcaster.subscriptionCount === 2; index += 1) {
      expect((await bus.publish(deltaInput(largeDelta, RUN_A))).ok).toBe(true);
    }
    await Promise.race([
      slowClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("slow event client was not disconnected")), 5_000),
      ),
    ]);

    expect(broadcaster.subscriptionCount).toBe(1);
    expect(healthySocket.destroyed).toBe(false);
    healthySocket.destroy();
  }, 10_000);
});
