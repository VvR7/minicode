import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionDiagnostic, Environment } from "@minicode/protocol";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/client";
import { createMcpClient, type McpClient, type McpClientFactory } from "./client.ts";
import { loadMcpConfig, type McpConfigCatalog } from "./config.ts";

export interface ConnectedMcpServer {
  readonly name: string;
  readonly executeMode: "serial" | "parallel";
  readonly client: McpClient;
  readonly tools: readonly McpToolDefinition[];
}
export interface McpWorkspaceSnapshot {
  readonly servers: readonly ConnectedMcpServer[];
  readonly diagnostics: readonly ExtensionDiagnostic[];
}

/** 管理 daemon 范围内、按工作区隔离且固定至重启的 MCP 配置与连接。 */
export class McpServerManager {
  readonly #environment: Environment;
  readonly #global: McpConfigCatalog;
  readonly #factory: McpClientFactory;
  readonly #workspaces = new Map<string, Promise<McpWorkspaceSnapshot>>();
  readonly #clients = new Set<McpClient>();
  readonly #shutdown = new AbortController();
  #closing: Promise<void> | undefined;

  /** 启动时固定全局配置，项目配置在对应工作区首次使用时固定。 */
  constructor(
    homeDirectory: string,
    environment: Environment,
    factory: McpClientFactory = createMcpClient,
  ) {
    this.#environment = { ...environment };
    this.#global = loadMcpConfig(join(homeDirectory, "config.toml"), this.#environment);
    this.#factory = factory;
  }

  /** 规范化工作区并共享其一次性初始化 Promise，避免重复连接。 */
  async forWorkspace(workspaceRoot: string): Promise<McpWorkspaceSnapshot> {
    if (this.#shutdown.signal.aborted) throw new Error("MCP manager is closed");
    const absolute = resolve(workspaceRoot);
    const root = await realpath(absolute).catch(() => absolute);
    if (this.#shutdown.signal.aborted) throw new Error("MCP manager is closed");
    let snapshot = this.#workspaces.get(root);
    if (!snapshot) {
      snapshot = this.#connectWorkspace(root);
      this.#workspaces.set(root, snapshot);
    }
    return snapshot;
  }

  /** 同名项目服务器覆盖全局；单服务器失败关闭该连接，其他服务器继续发现。 */
  async #connectWorkspace(workspaceRoot: string): Promise<McpWorkspaceSnapshot> {
    const project = loadMcpConfig(
      join(workspaceRoot, ".minicode", "config.toml"),
      this.#environment,
    );
    const configs = new Map(this.#global.servers.map((server) => [server.name, server]));
    for (const config of project.servers) configs.set(config.name, config);
    const servers: ConnectedMcpServer[] = [];
    const diagnostics = [...this.#global.diagnostics, ...project.diagnostics];
    for (const config of configs.values()) {
      if (this.#shutdown.signal.aborted) break;
      let client: McpClient | undefined;
      try {
        client = this.#factory(config, workspaceRoot);
        this.#clients.add(client);
        await client.connect(this.#shutdown.signal);
        const tools = await client.listTools(this.#shutdown.signal);
        if (this.#shutdown.signal.aborted) throw new Error("manager closed");
        servers.push({
          name: config.name,
          executeMode: config.execute_mode ?? "parallel",
          client,
          tools: structuredClone(tools),
        });
      } catch {
        if (client) {
          await client.close().catch(() => {});
          this.#clients.delete(client);
        }
        diagnostics.push({
          path: workspaceRoot,
          code: "mcp_connection_failed",
          message: `MCP 服务器 ${config.name} 连接或工具发现失败`,
        });
      }
    }
    return { servers, diagnostics };
  }

  /** 中断初始化与在途请求，等待发现结束，再关闭全部连接和 stdio 子进程。 */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#shutdown.abort();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#clients].map((client) => client.close()));
      await Promise.allSettled(this.#workspaces.values());
      await Promise.allSettled([...this.#clients].map((client) => client.close()));
      this.#clients.clear();
      this.#workspaces.clear();
    })();
    return this.#closing;
  }
}
