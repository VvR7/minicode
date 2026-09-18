import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerManager } from "../../src/mcp/server-manager.ts";
import { loadMcpConfig } from "../../src/mcp/config.ts";
import type { McpClientFactory } from "../../src/mcp/client.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** 创建独立配置目录。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minicode-mcp-"));
  roots.push(root);
  return root;
}
/** 写入全局或项目配置。 */
async function config(directory: string, text: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "config.toml");
  await writeFile(path, text);
  return path;
}
const server = (name: string, command: string) =>
  `[[mcp.servers]]\nname = "${name}"\ntransport = "stdio"\ncommand = "${command}"\n`;

test("config validates each server and substitutes environment without exposing credentials", async () => {
  const root = await fixture();
  const path = await config(
    root,
    server("good", "bun") +
      `[mcp.servers.env]\nKEY="\${TOKEN}"\n` +
      server("missing", `\${MISSING}`) +
      '[[mcp.servers]]\nname="invalid"\ntransport="tcp"\n',
  );
  const catalog = loadMcpConfig(path, { TOKEN: "secret-auth" });
  expect(catalog.servers[0]?.transport === "stdio" && catalog.servers[0].env).toEqual({
    KEY: "secret-auth",
  });
  expect(catalog.servers).toHaveLength(1);
  expect(catalog.diagnostics.map((d) => d.code)).toEqual([
    "missing_mcp_environment",
    "invalid_mcp_server",
  ]);
  expect(JSON.stringify(catalog.diagnostics)).not.toContain("secret-auth");
  expect(loadMcpConfig(join(root, "absent.toml"), {}).diagnostics).toEqual([]);
  await writeFile(path, "invalid = [");
  expect(loadMcpConfig(path, {}).diagnostics[0]?.code).toBe("invalid_mcp_config");
});

test("project overrides global, workspace initialization is cached, failures isolate, restart refreshes", async () => {
  const root = await fixture();
  const home = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  await config(home, server("shared", "global"));
  await config(join(first, ".minicode"), server("shared", "project") + server("broken", "broken"));
  await mkdir(second);
  const started: string[] = [];
  const closed: string[] = [];
  const factory: McpClientFactory = (cfg, workspace) => ({
    async connect() {
      started.push(`${workspace}:${cfg.transport === "stdio" ? cfg.command : "http"}`);
      if (cfg.name === "broken") throw new Error("secret credential from server");
    },
    async listTools() {
      return [{ name: "echo", inputSchema: { type: "object" } }];
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closed.push(cfg.name);
    },
  });
  const manager = new McpServerManager(home, {}, factory);
  await config(home, server("shared", "global-updated"));
  const [a, same] = await Promise.all([manager.forWorkspace(first), manager.forWorkspace(first)]);
  expect(a).toBe(same);
  expect(a.servers.map((s) => s.name)).toEqual(["shared"]);
  expect(a.diagnostics[0]?.code).toBe("mcp_connection_failed");
  expect(JSON.stringify(a.diagnostics)).not.toContain("secret credential");
  await config(join(first, ".minicode"), server("shared", "project-updated"));
  expect(await manager.forWorkspace(first)).toBe(a);
  await manager.forWorkspace(second);
  expect(started).toEqual([`${first}:project`, `${first}:broken`, `${second}:global`]);
  await manager.close();
  expect(closed).toContain("broken");
  expect(closed.filter((n) => n === "shared").length).toBeGreaterThanOrEqual(2);
  await expect(manager.forWorkspace(first)).rejects.toThrow("closed");
  const restarted = new McpServerManager(home, {}, factory);
  await restarted.forWorkspace(first);
  await restarted.forWorkspace(second);
  await restarted.close();
  expect(started.slice(-2)).toEqual([`${first}:project-updated`, `${second}:global-updated`]);
});

test("shutdown aborts and reaps pending initialization without starting another server", async () => {
  const root = await fixture();
  await config(root, server("one", "bun") + server("two", "bun"));
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  let closes = 0;
  let creates = 0;
  const manager = new McpServerManager(root, {}, () => {
    creates++;
    return {
      async connect(signal) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [] };
      },
      async close() {
        closes++;
      },
    };
  });
  const loading = manager.forWorkspace(root);
  await entered.promise;
  const closing = manager.close();
  expect(manager.close()).toBe(closing);
  await closing;
  expect((await loading).servers).toHaveLength(0);
  expect(aborted).toBe(true);
  expect(creates).toBe(1);
  expect(closes).toBeGreaterThan(0);
});
