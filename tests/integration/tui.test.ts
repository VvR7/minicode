import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestRenderer } from "@opentui/core/testing";

import { startAnthropicMock } from "./helpers/anthropic-mock.ts";

import type { Subprocess } from "bun";

import { TuiApp } from "../../packages/tui/src/app.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const coreBin = fileURLToPath(new URL("../../packages/core/src/bin.ts", import.meta.url));

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

interface CoreEnv {
  MINICODE_CORE_HOST: string;
  MINICODE_CORE_PORT: string;
  MINICODE_HOME: string;
  MINICODE_LOG_LEVEL: string;
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  [name: string]: string | undefined;
}

function spawnCore(port: number, homeDirectory: string, llmBaseUrl?: string): Subprocess {
  const env: CoreEnv = {
    ...process.env,
    MINICODE_CORE_HOST: "127.0.0.1",
    MINICODE_CORE_PORT: String(port),
    MINICODE_HOME: homeDirectory,
    MINICODE_LOG_LEVEL: "error",
    LLM_API_KEY: "",
    LLM_BASE_URL: "",
    LLM_MODEL: "",
  };
  if (llmBaseUrl !== undefined) {
    env.LLM_API_KEY = "test-key";
    env.LLM_BASE_URL = llmBaseUrl;
    env.LLM_MODEL = "test-model";
  }
  return Bun.spawn([process.execPath, coreBin], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "minicode-tui-"));
  await writeFile(join(directory, "README.md"), "content-alpha", "utf8");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
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

async function startCore(llmBaseUrl?: string) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-tui-home-"));
  const port = await getFreePort();
  const core = spawnCore(port, homeDirectory, llmBaseUrl);
  cleanups.push(async () => {
    core.kill("SIGTERM");
    await core.exited;
  });
  cleanups.push(() => rm(homeDirectory, { recursive: true, force: true }));
  // 等待 core 监听端口；CI 冷启动 JIT + 首次 spawn 可能较慢，给足余量。
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await canConnect(port)) {
      return { port, core, homeDirectory };
    }
    await Bun.sleep(10);
  }
  throw new Error("core did not start listening");
}

interface HeadlessSetup {
  renderer: { destroy(): void };
  mockInput: { pressKey(key: string): void };
  waitForFrame(
    predicate: (frame: string) => boolean | Promise<boolean>,
    options?: { maxPasses?: number },
  ): Promise<string>;
  captureCharFrame(): string;
}

/**
 * 事件驱动地轮询渲染帧直到包含目标文本。
 * 只监听渲染器自身调度产出的 FRAME 事件，不直接驱动原生 loop()，
 * 避免与调度器并发驱动导致偶发死锁；渲染器空闲时由外层重试吸收跨进程延迟。
 */
async function waitForText(setup: HeadlessSetup, text: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFrame = "";
  while (Date.now() < deadline) {
    lastFrame = setup.captureCharFrame();
    if (lastFrame.includes(text)) {
      return;
    }
    try {
      await setup.waitForFrame((frame) => frame.includes(text), { maxPasses: 4 });
      return;
    } catch {
      // 渲染器暂时空闲或无新帧：等待跨进程 IPC 事件推进后再重试。
      await Bun.sleep(20);
    }
  }
  throw new Error(`timed out waiting for frame containing: ${text}\nlast frame:\n${lastFrame}`);
}

/** 等待跨进程测试条件成立，超时后给出明确失败原因。 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for integration condition");
}

/** 等待指定端口重新开始监听。 */
async function waitUntilListening(port: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("core did not start listening");
}

describe("mc-tui process-level E2E (headless)", () => {
  beforeAll(async () => {
    // 预热原生渲染器：首个 createTestRenderer 的冷初始化存在偶发竞争导致挂起，
    // 先用一个临时渲染器把原生模块/渲染线程加载起来，再销毁。
    const warmup = await createTestRenderer({ width: 40, height: 4, exitOnCtrlC: false });
    warmup.renderer.destroy();
  });

  test("streams a mock-provider run and quits with 0", async () => {
    const mock = startAnthropicMock();
    cleanups.push(mock.stop);
    const { port } = await startCore(mock.url);
    const workspace = await makeWorkspace();

    const setup = await createTestRenderer({ width: 90, height: 14, exitOnCtrlC: false });
    cleanups.push(() => Promise.resolve(setup.renderer.destroy()));

    const app = new TuiApp();
    const codePromise = app.run({
      goal: "summarize the README",
      workspaceRoot: workspace,
      endpoint: { host: "127.0.0.1", port },
      createRenderer: async () => setup.renderer,
      reconnectDelayMs: 20,
    });

    // 只等待 durable 终态，再在同一帧检查最终文本；避免停在流式中间态时误触取消。
    await waitForText(setup, "succeeded");
    expect(setup.captureCharFrame()).toContain("SUMMARY:content-alpha");
    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(0);
    expect(mock.callCount).toBe(2);
  }, 60_000);

  test("shows a failed run for missing LLM config and quits with 1", async () => {
    const { port } = await startCore();
    const workspace = await makeWorkspace();

    const setup = await createTestRenderer({ width: 90, height: 14, exitOnCtrlC: false });
    cleanups.push(() => Promise.resolve(setup.renderer.destroy()));

    const app = new TuiApp();
    const codePromise = app.run({
      goal: "summarize",
      workspaceRoot: workspace,
      endpoint: { host: "127.0.0.1", port },
      createRenderer: async () => setup.renderer,
      reconnectDelayMs: 20,
    });

    await waitForText(setup, "config_error");
    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(1);
  });

  test("keeps retrying an unreachable core and quits with 130", async () => {
    const port = await getFreePort();
    const workspace = await makeWorkspace();

    const setup = await createTestRenderer({ width: 90, height: 14, exitOnCtrlC: false });
    cleanups.push(() => Promise.resolve(setup.renderer.destroy()));

    const app = new TuiApp();
    const codePromise = app.run({
      goal: "summarize",
      workspaceRoot: workspace,
      endpoint: { host: "127.0.0.1", port },
      createRenderer: async () => setup.renderer,
      reconnectDelayMs: 20,
    });

    await waitForText(setup, "retrying");
    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(130);
  });

  test("cancels a real running Core run and exits with 130", async () => {
    const mock = startAnthropicMock({ delayMs: 2_000 });
    cleanups.push(mock.stop);
    const { port } = await startCore(mock.url);
    const workspace = await makeWorkspace();
    const setup = await createTestRenderer({ width: 90, height: 14, exitOnCtrlC: false });
    cleanups.push(() => Promise.resolve(setup.renderer.destroy()));

    const app = new TuiApp();
    const codePromise = app.run({
      goal: "summarize",
      workspaceRoot: workspace,
      endpoint: { host: "127.0.0.1", port },
      createRenderer: async () => setup.renderer,
      reconnectDelayMs: 20,
      cancelTimeoutMs: 3_000,
    });

    await waitForCondition(() => mock.callCount >= 1);
    setup.mockInput.pressKey("q");
    await waitForText(setup, "cancelled");
    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(130);
  }, 30_000);

  test("reconnects after Core restart and replays the terminal event", async () => {
    const mock = startAnthropicMock({ delayMs: 5_000 });
    cleanups.push(mock.stop);
    const { port, core, homeDirectory } = await startCore(mock.url);
    const workspace = await makeWorkspace();
    const setup = await createTestRenderer({ width: 90, height: 14, exitOnCtrlC: false });
    cleanups.push(() => Promise.resolve(setup.renderer.destroy()));

    const app = new TuiApp();
    const codePromise = app.run({
      goal: "summarize",
      workspaceRoot: workspace,
      endpoint: { host: "127.0.0.1", port },
      createRenderer: async () => setup.renderer,
      reconnectDelayMs: 20,
    });

    await waitForCondition(() => mock.callCount >= 1);
    // 强制终止以确保 live 终态来不及送达；重启后只能依赖 journal replay。
    core.kill("SIGKILL");
    await core.exited;
    await waitForText(setup, "reconnecting");

    const restarted = spawnCore(port, homeDirectory, mock.url);
    cleanups.push(async () => {
      restarted.kill("SIGTERM");
      await restarted.exited;
    });
    await waitUntilListening(port);
    await waitForText(setup, "core_restarted");
    setup.mockInput.pressKey("q");

    expect(await codePromise).toBe(1);
  }, 60_000);
});
