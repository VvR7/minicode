import { describe, expect, test } from "bun:test";
import { createServer, createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const coreBin = fileURLToPath(new URL("../packages/core/src/bin.ts", import.meta.url));
const pingBin = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));

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

function testEnvironment(port: number | string): Record<string, string | undefined> {
  return {
    ...process.env,
    MINICODE_CORE_HOST: "127.0.0.1",
    MINICODE_CORE_PORT: String(port),
    MINICODE_LOG_LEVEL: "error",
  };
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilListening(port: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`core did not start listening on port ${port}`);
}

function spawnCore(port: number) {
  return Bun.spawn([process.execPath, coreBin], {
    cwd: repositoryRoot,
    env: testEnvironment(port),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCommand(
  command: readonly string[],
  environment: Record<string, string | undefined>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const process = Bun.spawn([...command], {
    cwd: repositoryRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("mc-core and mc-ping processes", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "complete a real ping and stop cleanly on %s",
    async (signal) => {
      const port = await getFreePort();
      const core = spawnCore(port);
      try {
        await waitUntilListening(port);
        const ping = await runCommand([process.execPath, pingBin], testEnvironment(port));

        expect(ping.exitCode).toBe(0);
        expect(ping.stderr).toBe("");
        expect(ping.stdout).toMatch(/^pong server=0\.0\.1 uptime=\d+ms latency=\d+ms\n$/);

        core.kill(signal);
        expect(await core.exited).toBe(0);
      } finally {
        if (core.exitCode === null) {
          core.kill("SIGTERM");
          await core.exited;
        }
      }
    },
  );

  test("reports a port collision with runtime exit code 1", async () => {
    const port = await getFreePort();
    const first = spawnCore(port);
    try {
      await waitUntilListening(port);
      const second = await runCommand([process.execPath, coreBin], testEnvironment(port));

      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("failed to listen");
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  });

  test("uses exit code 2 for arguments and invalid configuration", async () => {
    const environment = testEnvironment(7437);
    const [coreArgs, pingArgs, invalidPort] = await Promise.all([
      runCommand([process.execPath, coreBin, "unexpected"], environment),
      runCommand([process.execPath, pingBin, "unexpected"], environment),
      runCommand([process.execPath, pingBin], testEnvironment("invalid")),
    ]);

    expect(coreArgs.exitCode).toBe(2);
    expect(pingArgs.exitCode).toBe(2);
    expect(invalidPort.exitCode).toBe(2);
  });

  test("uses exit code 1 when core is unavailable", async () => {
    const port = await getFreePort();
    const result = await runCommand([process.execPath, pingBin], testEnvironment(port));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot connect to core");
  });
});
