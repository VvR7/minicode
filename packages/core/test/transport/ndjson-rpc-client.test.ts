import { afterEach, describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import type { CoreEndpoint, JsonRpcId, JsonRpcNotificationEnvelope } from "@minicode/protocol";
import { CORE_PING_METHOD, MAX_JSON_RPC_FRAME_BYTES, PongResultSchema } from "@minicode/protocol";
import {
  NdjsonRpcClient,
  NdjsonRpcConnection,
  RpcClientError,
} from "../../src/transport/ndjson-rpc-client.ts";

interface MockServer {
  readonly endpoint: CoreEndpoint;
  close(): Promise<void>;
}

interface RawRequest extends Record<string, unknown> {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const mockServers: MockServer[] = [];

function pingCore(
  endpoint: CoreEndpoint,
  options: { readonly timeoutMs?: number; readonly requestId?: JsonRpcId } = {},
) {
  const client = new NdjsonRpcClient(endpoint, options);
  return client.request(
    CORE_PING_METHOD,
    { clientName: "mc-ping", clientVersion: "0.0.1" },
    PongResultSchema,
    options,
  );
}

async function startMockServer(
  respond: (request: RawRequest, socket: Socket) => void,
): Promise<MockServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (data) => {
      input += data.toString("utf8");
      while (true) {
        const newlineIndex = input.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const request = JSON.parse(input.slice(0, newlineIndex)) as RawRequest;
        input = input.slice(newlineIndex + 1);
        respond(request, socket);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }

  const mock: MockServer = {
    endpoint: { host: "127.0.0.1", port: address.port },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
  mockServers.push(mock);
  return mock;
}

afterEach(async () => {
  await Promise.all(mockServers.splice(0).map((server) => server.close()));
});

describe("NDJSON RPC client", () => {
  test("returns a valid pong and checks the request shape", async () => {
    const server = await startMockServer((request, socket) => {
      expect(request.method).toBe("core.ping");
      expect(request.params).toEqual({ clientName: "mc-ping", clientVersion: "0.0.1" });
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            serverVersion: "0.0.1",
            uptimeMs: 12,
            receivedAt: "2026-09-12T06:00:00.000Z",
          },
        })}\n`,
      );
    });

    const response = await pingCore(server.endpoint, { requestId: "known-id" });
    expect(response.result.serverVersion).toBe("0.0.1");
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("rejects a mismatched response id", async () => {
    const server = await startMockServer((_request, socket) => {
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "wrong-id",
          result: {
            serverVersion: "0.0.1",
            uptimeMs: 1,
            receivedAt: "2026-09-12T06:00:00.000Z",
          },
        })}\n`,
      );
    });

    await expect(pingCore(server.endpoint, { requestId: "expected-id" })).rejects.toThrow(
      "mismatched response id",
    );
  });

  test("rejects invalid JSON and invalid response shapes", async () => {
    const invalidJson = await startMockServer((_request, socket) => socket.end("not json\n"));
    await expect(pingCore(invalidJson.endpoint)).rejects.toThrow("invalid JSON");

    const invalidShape = await startMockServer((_request, socket) =>
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: "x", result: {} })}\n`),
    );
    await expect(pingCore(invalidShape.endpoint, { requestId: "x" })).rejects.toThrow(
      "invalid response",
    );
  });

  test("surfaces JSON-RPC errors", async () => {
    const server = await startMockServer((request, socket) => {
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "Internal error" },
        })}\n`,
      );
    });

    await expect(pingCore(server.endpoint)).rejects.toThrow("core error -32603: Internal error");
  });

  test("reports EOF before a response", async () => {
    const server = await startMockServer((_request, socket) => socket.end());

    await expect(pingCore(server.endpoint)).rejects.toThrow("closed the connection");
  });

  test("enforces the end-to-end timeout", async () => {
    const server = await startMockServer(() => {});

    try {
      await pingCore(server.endpoint, { timeoutMs: 30 });
      throw new Error("expected ping to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcClientError);
      if (!(error instanceof RpcClientError)) {
        throw error;
      }
      expect(error.message).toContain("request timed out after 30ms");
    }
  });

  test("correlates out-of-order responses while receiving interleaved notifications", async () => {
    const requests: RawRequest[] = [];
    const server = await startMockServer((request, socket) => {
      requests.push(request);
      if (requests.length !== 2) {
        return;
      }
      const response = (id: unknown, uptimeMs: number) =>
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            serverVersion: "0.0.1",
            uptimeMs,
            receivedAt: "2026-09-13T08:00:00.000Z",
          },
        })}\n`;
      const notification = `${JSON.stringify({
        jsonrpc: "2.0",
        method: "event.push",
        params: { subscriptionId: "subscription-1", event: { sequence: 1 } },
      })}\n`;
      const firstWrite = `${response(request.id, 2)}${notification}`;
      // 主动拆帧，验证同一数据流中半帧、多帧和 notification 都能正确处理。
      const midpoint = Math.floor(firstWrite.length / 2);
      socket.write(firstWrite.slice(0, midpoint));
      setTimeout(() => {
        socket.write(`${firstWrite.slice(midpoint)}${response(requests[0]?.id, 1)}`);
      }, 5);
    });
    const connection = await NdjsonRpcConnection.connect(server.endpoint);
    const notifications: JsonRpcNotificationEnvelope[] = [];
    connection.onNotification((notification) => notifications.push(notification));

    const first = connection.request(CORE_PING_METHOD, {}, PongResultSchema, {
      requestId: "first",
    });
    const second = connection.request(CORE_PING_METHOD, {}, PongResultSchema, {
      requestId: "second",
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.result.uptimeMs).toBe(1);
    expect(secondResult.result.uptimeMs).toBe(2);
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "event.push",
        params: { subscriptionId: "subscription-1", event: { sequence: 1 } },
      },
    ]);
    connection.close();
  });

  test("delivers a coalesced notification after the preceding response continuation", async () => {
    const server = await startMockServer((request, socket) => {
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            serverVersion: "0.0.1",
            uptimeMs: 1,
            receivedAt: "2026-09-13T08:00:00.000Z",
          },
        })}\n${JSON.stringify({
          jsonrpc: "2.0",
          method: "event.push",
          params: { subscriptionId: "subscription-1", event: { sequence: 1 } },
        })}\n`,
      );
    });
    const connection = await NdjsonRpcConnection.connect(server.endpoint);
    const order: string[] = [];
    const received = Promise.withResolvers<void>();

    await connection.request(CORE_PING_METHOD, {}, PongResultSchema, { requestId: "ordered" });
    order.push("response");
    connection.onNotification(() => {
      order.push("notification");
      received.resolve();
    });
    await received.promise;

    expect(order).toEqual(["response", "notification"]);
    connection.close();
  });

  test("rejects every pending request when the persistent socket disconnects", async () => {
    let requestCount = 0;
    const server = await startMockServer((_request, socket) => {
      requestCount += 1;
      if (requestCount === 2) {
        socket.destroy();
      }
    });
    const connection = await NdjsonRpcConnection.connect(server.endpoint);
    const first = connection.request(CORE_PING_METHOD, {}, PongResultSchema, {
      requestId: "first",
    });
    const second = connection.request(CORE_PING_METHOD, {}, PongResultSchema, {
      requestId: "second",
    });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(RpcClientError);
        expect((outcome.reason as Error).message).toContain("closed the connection");
      }
    }
    expect(connection.closed).toBe(true);
  });

  test("closes a persistent connection on an oversized inbound frame", async () => {
    const server = await startMockServer((_request, socket) => {
      socket.write(`${"x".repeat(MAX_JSON_RPC_FRAME_BYTES + 1)}\n`);
    });
    const connection = await NdjsonRpcConnection.connect(server.endpoint);

    await expect(
      connection.request(CORE_PING_METHOD, {}, PongResultSchema, { requestId: "large" }),
    ).rejects.toThrow("frame exceeds 1 MiB");
    expect(connection.closed).toBe(true);
  });
});
