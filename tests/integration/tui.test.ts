import { afterEach, describe, expect, test } from "bun:test";
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
  // 等待 core 监听端口。
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    if (await canConnect(port)) {
      return { port, core, homeDirectory };
    }
    await Bun.sleep(10);
  }
  throw new Error("core did not start listening");
}

interface HeadlessSetup {
  renderer: { requestRender(): void; destroy(): void };
  mockInput: { pressKey(key: string): void };
  renderOnce(): Promise<void>;
  captureCharFrame(): string;
}

/** 以真实时间轮询渲染帧，直到包含目标文本；比 waitForFrame 更适合跨进程异步事件。 */
async function waitForText(setup: HeadlessSetup, text: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 先让异步事件与原生渲染线程推进，再主动跑一帧并读取。
    await Bun.sleep(20);
    setup.renderer.requestRender();
    await setup.renderOnce();
    if (setup.captureCharFrame().includes(text)) {
      return;
    }
  }
  throw new Error(`timed out waiting for frame containing: ${text}`);
}

describe("mc-tui process-level E2E (headless)", () => {
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

    await waitForText(setup, "SUMMARY:content-alpha");
    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(0);
    expect(mock.callCount).toBe(2);
  });

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
});
