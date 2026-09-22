import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import {
  type ClientPermission,
  NdjsonRpcConnection,
  SessionController,
} from "../../packages/client/src/index.ts";
import { CoreApp } from "../../packages/core/src/index.ts";
import { TuiApp } from "../../packages/tui/src/app.ts";
import { startScriptedAnthropicMock } from "./helpers/scripted-anthropic-mock.ts";

/** 等待 socket 通知或异步渲染推进，并以真实时间上限保证失败后可清理。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("TUI approval timed out");
    await Bun.sleep(5);
  }
}

test("TUI restores pending approval after real reconnect and keyboard approval executes write", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-tui-approval-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minicode-tui-approval-workspace-"));
  const mock = startScriptedAnthropicMock((_body, call) =>
    call === 1
      ? {
          kind: "tools",
          calls: [
            {
              id: "write-1",
              name: "write",
              input: { path: "approved.txt", content: "approved content" },
            },
          ],
        }
      : { kind: "text", chunks: ["done"] },
  );
  const app = new CoreApp(
    {
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      permissionMode: "alwaysask",
      homeDirectory,
    },
    {
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: mock.url,
      LLM_MODEL: "test-model",
      LLM_CONTEXT_WINDOW_TOKENS: "100000",
      LLM_MAX_OUTPUT_TOKENS: "4096",
      MINICODE_TRACE_ENABLED: "false",
    },
  );
  const endpoint = app.start();
  const setup = await createTestRenderer({
    width: 100,
    height: 30,
    exitOnCtrlC: false,
    kittyKeyboard: true,
  });
  const connections: NdjsonRpcConnection[] = [];
  let permissions: readonly ClientPermission[] = [];
  let committed = false;
  let controller: SessionController | undefined;
  let reconnectSnapshots = 0;
  const code = new TuiApp().run({
    mode: { kind: "new", goal: "write a file" },
    workspaceRoot,
    endpoint,
    createRenderer: async () => setup.renderer,
    createController: (consume, onPermissions) => {
      controller = new SessionController({
        endpoint,
        reconnectDelayMs: 0,
        connect: async (target) => {
          const connection = await NdjsonRpcConnection.connect(target);
          connections.push(connection);
          return connection;
        },
        onEvent: (event) => {
          consume(event);
          if (event.type === "turn.committed") committed = true;
        },
        onPermissions: (entries) => {
          permissions = entries;
          if (connections.length >= 3 && entries.some((entry) => entry.status === "pending"))
            reconnectSnapshots++;
          onPermissions(entries);
        },
      });
      return controller;
    },
  });
  try {
    await waitFor(() => permissions.some((entry) => entry.status === "pending"));
    await setup.waitForFrame((frame) => frame.includes("[PERMISSION]"));
    const id = permissions[0]?.request.payload.permissionRequestId;
    connections.at(-1)?.close();
    await waitFor(() => reconnectSnapshots > 0);
    expect(permissions.filter((entry) => entry.status === "pending")).toHaveLength(1);
    expect(permissions[0]?.request.payload.permissionRequestId).toBe(id);
    setup.mockInput.pressKey("y");
    await waitFor(() => committed);
    expect(permissions[0]?.status).toBe("resolved");
    expect(permissions[0]?.resolution?.payload.decision).toBe("allow_once");
    expect(await readFile(join(workspaceRoot, "approved.txt"), "utf8")).toBe("approved content");
    // renderer 暂时 idle 不代表 Markdown worker 已完成；让出事件循环等待最终字符帧。
    await waitFor(() => {
      const frame = setup.captureCharFrame();
      return frame.includes("done") && frame.includes("Allow once");
    });
    await setup.mockInput.typeText("/exit");
    setup.mockInput.pressEnter();
    expect(await code).toBe(0);
  } finally {
    await controller?.dispose();
    for (const connection of connections) connection.close();
    setup.renderer.destroy();
    await app.stop();
    await mock.stop();
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
