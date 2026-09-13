import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";

import type { CoreEndpoint } from "@minicode/protocol";
import { runPingCommand } from "../../src/commands/ping.ts";

import type { Server } from "node:net";

const servers: Server[] = [];

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function startPingServer(): Promise<CoreEndpoint> {
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (data) => {
      input += data.toString("utf8");
      const newlineIndex = input.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newlineIndex)) as { readonly id: unknown };
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
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }
  return { host: "127.0.0.1", port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("ping command", () => {
  test("prints a successful round trip", async () => {
    const endpoint = await startPingServer();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runPingCommand(endpoint, { requestId: "command-test" })).resolves.toBe(0);
      expect(String(log.mock.calls[0]?.[0])).toMatch(
        /^pong server=0\.0\.1 uptime=12ms latency=\d+ms$/u,
      );
    } finally {
      log.mockRestore();
    }
  });

  test("prints a safe transport failure", async () => {
    const port = await getFreePort();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runPingCommand({ host: "127.0.0.1", port })).resolves.toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain("cannot connect to core");
    } finally {
      error.mockRestore();
    }
  });
});
