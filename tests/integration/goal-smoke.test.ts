import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 真实 provider smoke test（opt-in）。
 *
 * 默认 CI 不运行（避免真实 LLM 网络请求）。本地手动验证时：
 *
 *   MINICODE_REAL_LLM=1 bun test tests/integration/goal-smoke.test.ts
 *
 * 需要 .env 中的 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 已配置。
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const coreBin = fileURLToPath(new URL("../../packages/core/src/bin.ts", import.meta.url));
const mcBin = fileURLToPath(new URL("../../packages/cli/src/mc.ts", import.meta.url));

const smokeEnabled = (Bun.env as { MINICODE_REAL_LLM?: string }).MINICODE_REAL_LLM === "1";

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

async function waitUntilListening(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`core did not start listening on port ${port}`);
}

function coreEnvironment(port: number, homeDirectory: string): Record<string, string | undefined> {
  return {
    // 继承 .env 中的真实 LLM_* 配置（smoke 测试正是要打真实 provider）。
    ...process.env,
    MINICODE_CORE_HOST: "127.0.0.1",
    MINICODE_CORE_PORT: String(port),
    MINICODE_HOME: homeDirectory,
    MINICODE_LOG_LEVEL: "error",
  };
}

test.skipIf(!smokeEnabled)("runs a real mc --goal against the configured provider", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-smoke-"));
  const workspace = await mkdtemp(join(tmpdir(), "minicode-smoke-ws-"));
  await writeFile(join(workspace, "README.md"), "minicode is a local coding agent.\n", "utf8");
  const port = await getFreePort();
  const env = coreEnvironment(port, homeDirectory);

  const core = Bun.spawn([process.execPath, coreBin], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitUntilListening(port);

    const child = Bun.spawn(
      [process.execPath, mcBin, "--goal", "read README.md and summarize it in one sentence"],
      {
        cwd: workspace,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).toContain("run succeeded (completed)");
  } finally {
    core.kill("SIGTERM");
    await core.exited;
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
