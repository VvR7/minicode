import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startAnthropicMock } from "./helpers/anthropic-mock.ts";

import type { Subprocess } from "bun";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const coreBin = fileURLToPath(new URL("../../packages/core/src/bin.ts", import.meta.url));
const mcBin = fileURLToPath(new URL("../../packages/cli/src/mc.ts", import.meta.url));

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

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

async function waitUntilListening(port: number, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`core did not start listening on port ${port}`);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(10);
  }
}

interface CoreSpawnEnv {
  MINICODE_CORE_HOST: string;
  MINICODE_CORE_PORT: string;
  MINICODE_HOME: string;
  MINICODE_LOG_LEVEL: string;
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  [name: string]: string | undefined;
}

interface CoreEnvironment {
  readonly port: number;
  readonly homeDirectory: string;
  readonly llm?: { readonly baseUrl: string };
}

/** 启动 mc-core 进程。 */
function spawnCore(environment: CoreEnvironment): Subprocess {
  const env: CoreSpawnEnv = {
    ...process.env,
    MINICODE_CORE_HOST: "127.0.0.1",
    MINICODE_CORE_PORT: String(environment.port),
    MINICODE_HOME: environment.homeDirectory,
    MINICODE_LOG_LEVEL: "error",
    // 显式清除可能从开发者 .env 继承的真实 LLM 凭证，避免测试走真实网络。
    LLM_API_KEY: "",
    LLM_BASE_URL: "",
    LLM_MODEL: "",
  };
  if (environment.llm !== undefined) {
    env.LLM_API_KEY = "test-key";
    env.LLM_BASE_URL = environment.llm.baseUrl;
    env.LLM_MODEL = "test-model";
  }
  return Bun.spawn([process.execPath, coreBin], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCommand(
  command: readonly string[],
  environment: Record<string, string | undefined>,
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const process = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const collect = Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("command timed out")), timeoutMs),
  );
  const [exitCode, stdout, stderr] = await Promise.race([collect, timeout]);
  return { exitCode, stdout, stderr };
}

async function makeWorkspace(marker: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "minicode-workspace-"));
  await writeFile(join(directory, "README.md"), `content-${marker}`, "utf8");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function coreEnvironment(port: number, homeDirectory: string, baseUrl?: string): CoreSpawnEnv {
  const env: CoreSpawnEnv = {
    ...process.env,
    MINICODE_CORE_HOST: "127.0.0.1",
    MINICODE_CORE_PORT: String(port),
    MINICODE_HOME: homeDirectory,
    MINICODE_LOG_LEVEL: "error",
    LLM_API_KEY: "",
    LLM_BASE_URL: "",
    LLM_MODEL: "",
  };
  if (baseUrl !== undefined) {
    env.LLM_API_KEY = "test-key";
    env.LLM_BASE_URL = baseUrl;
    env.LLM_MODEL = "test-model";
  }
  return env;
}

describe("mc --goal process-level E2E", () => {
  test("mock provider drives read_file and streams the README summary to stdout", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-goal-"));
    const workspace = await makeWorkspace("alpha");
    const mock = startAnthropicMock();
    const port = await getFreePort();
    const core = spawnCore({ port, homeDirectory, llm: { baseUrl: mock.url } });
    cleanups.push(async () => {
      core.kill("SIGTERM");
      await core.exited;
    });
    cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
    cleanups.push(mock.stop);

    await waitUntilListening(port);

    const result = await runCommand(
      [process.execPath, mcBin, "--goal", "summarize the README"],
      coreEnvironment(port, homeDirectory, mock.url),
      workspace,
    );

    expect(result.exitCode).toBe(0);
    // stdout 仅含 assistant 流式文本（mock 返回 SUMMARY:content-alpha）。
    expect(result.stdout).toBe("SUMMARY:content-alpha");
    // 进度信息进入 stderr，不污染 stdout。
    expect(result.stdout).not.toContain("tool");
    expect(result.stdout).not.toContain("step");
    expect(result.stderr).toContain("tool read_file");
    expect(result.stderr).toContain("step 1");
    expect(result.stderr).toContain("run succeeded (completed)");
    // 两次 LLM 调用：首次 tool_use，第二次含 tool_result 后给出最终回答。
    expect(mock.callCount).toBe(2);
  });

  test("two concurrent CLI runs read different workspaces without cross-talk", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-goal-"));
    const workspaceA = await makeWorkspace("AAA");
    const workspaceB = await makeWorkspace("BBB");
    const mock = startAnthropicMock();
    const port = await getFreePort();
    const core = spawnCore({ port, homeDirectory, llm: { baseUrl: mock.url } });
    cleanups.push(async () => {
      core.kill("SIGTERM");
      await core.exited;
    });
    cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
    cleanups.push(mock.stop);

    await waitUntilListening(port);

    const [a, b] = await Promise.all([
      runCommand(
        [process.execPath, mcBin, "--goal", "summarize A"],
        coreEnvironment(port, homeDirectory, mock.url),
        workspaceA,
      ),
      runCommand(
        [process.execPath, mcBin, "--goal", "summarize B"],
        coreEnvironment(port, homeDirectory, mock.url),
        workspaceB,
      ),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe("SUMMARY:content-AAA");
    expect(b.stdout).toBe("SUMMARY:content-BBB");
    expect(a.stdout).not.toContain("BBB");
    expect(b.stdout).not.toContain("AAA");
  });

  test("reports usage error 2, config_error run failure 1, and unreachable core 2", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-goal-"));
    cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
    const workspace = await makeWorkspace("alpha");

    // usage：缺少 --goal。
    const usage = await runCommand([process.execPath, mcBin], {}, workspace);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("missing required --goal");

    // run failure：缺 LLM 配置 → run.finished(failed, config_error)。
    const noLlmPort = await getFreePort();
    const noLlmCore = spawnCore({ port: noLlmPort, homeDirectory });
    cleanups.push(async () => {
      noLlmCore.kill("SIGTERM");
      await noLlmCore.exited;
    });
    await waitUntilListening(noLlmPort);
    const configError = await runCommand(
      [process.execPath, mcBin, "--goal", "summarize"],
      coreEnvironment(noLlmPort, homeDirectory),
      workspace,
    );
    expect(configError.exitCode).toBe(1);
    expect(configError.stderr).toContain("config_error");

    // config：core 未运行 → 首次连接失败后退出 2。
    const deadPort = await getFreePort();
    const unreachable = await runCommand(
      [process.execPath, mcBin, "--goal", "summarize"],
      coreEnvironment(deadPort, homeDirectory),
      workspace,
    );
    expect(unreachable.exitCode).toBe(2);
    expect(unreachable.stderr).toContain("cannot connect to core");
  });

  test("Ctrl-C cancels the run and exits 130", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-goal-"));
    const workspace = await makeWorkspace("alpha");
    // 每次 LLM 调用延迟 5s，让 run 停留在第一次调用中等待取消。
    const mock = startAnthropicMock({ delayMs: 5_000 });
    const port = await getFreePort();
    const core = spawnCore({ port, homeDirectory, llm: { baseUrl: mock.url } });
    cleanups.push(async () => {
      core.kill("SIGTERM");
      await core.exited;
    });
    cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
    cleanups.push(mock.stop);

    await waitUntilListening(port);

    const child = Bun.spawn([process.execPath, mcBin, "--goal", "summarize"], {
      cwd: workspace,
      env: coreEnvironment(port, homeDirectory, mock.url),
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitFor(() => mock.callCount >= 1);
    await Bun.sleep(100);
    child.kill("SIGINT");

    const exited = await child.exited;
    expect(exited).toBe(130);

    core.kill("SIGTERM");
    await core.exited;
  });

  test("reconnects after the core restarts and replays the terminal event", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-goal-"));
    const workspace = await makeWorkspace("alpha");
    const mock = startAnthropicMock({ delayMs: 5_000 });
    const port = await getFreePort();
    const core = spawnCore({ port, homeDirectory, llm: { baseUrl: mock.url } });
    cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
    cleanups.push(mock.stop);

    await waitUntilListening(port);

    const child = Bun.spawn([process.execPath, mcBin, "--goal", "summarize"], {
      cwd: workspace,
      env: coreEnvironment(port, homeDirectory, mock.url),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();

    // run 已建立并在第一次 LLM 调用中，随后关停 core（会取消 active run）。
    await waitFor(() => mock.callCount >= 1);
    core.kill("SIGTERM");
    await core.exited;

    // 重启 core，mc 应重连并重放 run.finished(cancelled)。
    const restarted = spawnCore({ port, homeDirectory, llm: { baseUrl: mock.url } });
    cleanups.push(async () => {
      restarted.kill("SIGTERM");
      await restarted.exited;
    });
    await waitUntilListening(port);

    const [exitCode, stderr] = await Promise.all([child.exited, stdoutPromise, stderrPromise]).then(
      ([code, , err]) => [code, err] as const,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("run cancelled (cancelled)");
  });
});
