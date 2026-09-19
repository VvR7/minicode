import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGoalCommand } from "../../packages/cli/src/commands/goal.ts";
import { NdjsonRpcConnection, SessionController } from "../../packages/client/src/index.ts";
import { CoreApp } from "../../packages/core/src/index.ts";
import type { PermissionDecision } from "../../packages/protocol/src/index.ts";
import { startScriptedAnthropicMock } from "./helpers/scripted-anthropic-mock.ts";

/** 启动只请求一次 write 的真实 daemon，验证前端到工具的完整链路。 */
async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minicode-cli-approval-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minicode-cli-approval-workspace-"));
  const mock = startScriptedAnthropicMock((_body, call) =>
    call % 2 === 1
      ? {
          kind: "tools",
          calls: [
            {
              id: `write-${call}`,
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
  return {
    workspaceRoot,
    endpoint,
    /** 清理本测试创建的 daemon、mock 和临时目录。 */
    async cleanup() {
      await app.stop();
      await mock.stop();
      await rm(homeDirectory, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

/** 等待 IPC 回调推进主流程，超过 deadline 则令测试失败。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("client approval timed out");
    await Bun.sleep(5);
  }
}

describe("CLI/client permission flow (integration)", () => {
  test("mc subprocess with piped streams defaults to deny_once", async () => {
    const f = await fixture();
    const subprocess = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../packages/cli/src/mc.ts"),
        "--goal",
        "write",
      ],
      {
        cwd: f.workspaceRoot,
        env: {
          ...process.env,
          MINICODE_CORE_HOST: f.endpoint.host,
          MINICODE_CORE_PORT: String(f.endpoint.port),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => subprocess.kill(), 3000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("done");
      expect(stderr).toContain("permission denied");
      expect(stderr).not.toContain("Choose:");
      await expect(readFile(join(f.workspaceRoot, "approved.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clearTimeout(deadline);
      if (subprocess.exitCode === null) subprocess.kill();
      await f.cleanup();
    }
  });

  test("CLI reconnect withdraws old input and re-prompts the still pending request", async () => {
    const f = await fixture();
    const connections: NdjsonRpcConnection[] = [];
    const signals: AbortSignal[] = [];
    let stdout = "";
    try {
      expect(
        await runGoalCommand({
          goal: "write",
          ...f,
          interactive: true,
          reconnectDelayMs: 0,
          connect: async (endpoint) => {
            const connection = await NdjsonRpcConnection.connect(endpoint);
            connections.push(connection);
            return connection;
          },
          permissionPrompt: async (_request, signal) => {
            signals.push(signal);
            if (signals.length === 1) {
              connections[0]?.close();
              return new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve("deny_once"), { once: true }),
              );
            }
            return "allow_once";
          },
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => {},
        }),
      ).toBe(0);
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(connections).toHaveLength(2);
      expect(stdout).toBe("done");
      expect(await readFile(join(f.workspaceRoot, "approved.txt"), "utf8")).toBe(
        "approved content",
      );
    } finally {
      for (const connection of connections) connection.close();
      await f.cleanup();
    }
  });

  for (const decision of [
    "allow_once",
    "always_allow",
    "deny_once",
    "always_deny",
  ] satisfies PermissionDecision[]) {
    test(`CLI sends ${decision} and keeps approval/progress off stdout`, async () => {
      const f = await fixture();
      let stdout = "";
      let stderr = "";
      let prompts = 0;
      try {
        const code = await runGoalCommand({
          goal: "write a file",
          ...f,
          interactive: true,
          permissionPrompt: async (request) => {
            prompts++;
            expect(request.payload.summary.kind).toBe("write");
            return decision;
          },
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        });
        expect(code).toBe(0);
        expect(prompts).toBe(1);
        expect(stdout).toBe("done");
        expect(stderr).toContain(`permission ${decision.includes("allow") ? "allowed" : "denied"}`);
        if (decision.includes("allow"))
          expect(await readFile(join(f.workspaceRoot, "approved.txt"), "utf8")).toBe(
            "approved content",
          );
        else
          await expect(readFile(join(f.workspaceRoot, "approved.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
      } finally {
        await f.cleanup();
      }
    });
  }

  test("non-interactive CLI denies once without calling a prompt or hanging", async () => {
    const f = await fixture();
    let stdout = "";
    let stderr = "";
    try {
      expect(
        await runGoalCommand({
          goal: "write",
          ...f,
          interactive: false,
          permissionPrompt: async () => {
            throw new Error("prompt must not be called");
          },
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        }),
      ).toBe(0);
      expect(stdout).toBe("done");
      expect(stderr).toContain("permission denied");
      await expect(readFile(join(f.workspaceRoot, "approved.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("Ctrl-C releases a pending CLI prompt without sending its late decision", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const opened = Promise.withResolvers<AbortSignal>();
    const decision = Promise.withResolvers<PermissionDecision>();
    try {
      const running = runGoalCommand({
        goal: "write",
        ...f,
        interactive: true,
        signal: controller.signal,
        permissionPrompt: async (_request, signal) => {
          opened.resolve(signal);
          return decision.promise;
        },
        stdout: () => {},
        stderr: () => {},
      });
      const signal = await opened.promise;
      controller.abort();
      expect(await running).toBe(130);
      expect(signal.aborted).toBe(true);
      decision.resolve("allow_once");
      await Bun.sleep(0);
      await expect(readFile(join(f.workspaceRoot, "approved.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("SessionController approval uses session attachment and always decision across turns", async () => {
    const f = await fixture();
    let prompts = 0;
    let committed = 0;
    const controller = new SessionController({
      endpoint: f.endpoint,
      onEvent: (event) => {
        if (event.type === "turn.committed") committed++;
      },
      onPermissions: (permissions) => {
        const pending = permissions.find((entry) => entry.status === "pending");
        if (pending !== undefined) {
          prompts++;
          void controller.respondPermission(
            pending.request.runId,
            pending.request.payload.permissionRequestId,
            "always_allow",
          );
        }
      },
    });
    try {
      await controller.create(f.workspaceRoot);
      await controller.sendMessage("write first");
      await waitFor(() => committed === 1);
      await controller.sendMessage("write second");
      await waitFor(() => committed === 2);
      expect(prompts).toBe(1);
      expect(controller.permissions[0]?.status).toBe("resolved");
      expect(await readFile(join(f.workspaceRoot, "approved.txt"), "utf8")).toBe(
        "approved content",
      );
    } finally {
      await controller.dispose();
      await f.cleanup();
    }
  });
});
