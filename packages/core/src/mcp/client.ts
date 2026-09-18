import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool as McpToolDefinition,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./config.ts";

/** 连接管理与工具适配共用的最小 SDK 门面，测试可替换本地 client。 */
export interface McpClient {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<readonly McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}
export type McpClientFactory = (config: McpServerConfig, workspaceRoot: string) => McpClient;

/** 使用官方 v2 SDK 创建 transport，不把服务器 stderr 输出到 daemon 日志。 */
export const createMcpClient: McpClientFactory = (config, workspaceRoot) => {
  const client = new Client(
    { name: "minicode", version: "0.1.0" },
    { capabilities: {}, listMaxPages: Number.MAX_SAFE_INTEGER },
  );
  const transport =
    config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...getDefaultEnvironment(), ...config.env },
          cwd: workspaceRoot,
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
          reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
        });
  return {
    async connect(signal) {
      await client.connect(transport, { signal, timeout: 10000 });
    },
    // 官方 SDK 聚合分页；首次请求省略 cursor，避免把空串作为 opaque cursor。
    async listTools(signal) {
      return (await client.listTools(undefined, { signal, timeout: 10000 })).tools;
    },
    async callTool(name, args, signal) {
      return client.callTool({ name, arguments: args }, { signal, timeout: 10000 });
    },
    async close() {
      await client.close();
      await transport.close();
    },
  };
};
