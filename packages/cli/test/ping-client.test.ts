import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import type { Socket } from "node:net";
import type { CoreEndpoint } from "@minicode/protocol";
import { pingCore, PingClientError } from "../src/ping-client.ts";

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
      const newlineIndex = input.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newlineIndex)) as RawRequest;
      respond(request, socket);
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

describe("ping client", () => {
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
      expect(error).toBeInstanceOf(PingClientError);
      if (!(error instanceof PingClientError)) {
        throw error;
      }
      expect(error.message).toContain("timed out after 30ms");
    }
  });
});
