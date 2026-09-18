import type { CallToolResult, Tool as McpToolDefinition } from "@modelcontextprotocol/client";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import { z } from "zod";
import {
  ToolError,
  type Tool,
  type ToolExecutionContext,
  type ToolOutput,
} from "../tools/types.ts";
import type { ConnectedMcpServer, McpWorkspaceSnapshot } from "./server-manager.ts";

/** 保留文本与结构化结果，仅为其他内容提供类型和资源地址摘要。 */
export function mcpOutput(result: CallToolResult): ToolOutput {
  const parts = result.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") return `[resource_link: ${block.uri}]`;
    if (block.type === "resource") return `[resource: ${block.resource.uri}]`;
    return `[${block.type} content omitted]`;
  });
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return { content: parts.join("\n") };
}

/** 将外部 JSON Schema 和 SDK 调用适配到标准工具校验、审批与取消生命周期。 */
export class McpTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly executeMode: "serial" | "parallel";
  readonly llmInputSchema: Record<string, unknown>;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  readonly #server: ConnectedMcpServer;
  readonly #toolName: string;

  /** 固定发现结果，按声明的 JSON Schema 草案编译校验器，不修改调用参数。 */
  constructor(server: ConnectedMcpServer, definition: McpToolDefinition) {
    this.#server = server;
    this.#toolName = definition.name;
    this.name = `mcp__${server.name}__${definition.name}`;
    this.description = definition.description ?? `MCP tool ${definition.name}`;
    this.executeMode = server.executeMode;
    this.llmInputSchema = structuredClone(definition.inputSchema);
    const { $schema: draft } = this.llmInputSchema;
    const Validator =
      typeof draft === "string" && draft.includes("2020-12")
        ? Ajv2020
        : typeof draft === "string" && draft.includes("2019-09")
          ? Ajv2019
          : Ajv;
    const validator = new Validator({ strict: false });
    addFormats(validator);
    const validate = validator.compile(this.llmInputSchema);
    this.inputSchema = z.record(z.string(), z.unknown()).superRefine((params, context) => {
      if (!validate(params))
        context.addIssue({ code: "custom", message: "MCP parameters do not match JSON Schema" });
    });
  }

  /** 一次发送，不重试外部副作用；服务器错误保留安全的内容结果。 */
  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolOutput> {
    if (context.signal.aborted) throw new ToolError("tool_cancelled", "MCP call cancelled");
    let result: CallToolResult;
    try {
      result = await this.#server.client.callTool(this.#toolName, params, context.signal);
    } catch {
      if (context.signal.aborted) throw new ToolError("tool_cancelled", "MCP call cancelled");
      throw new ToolError("io_error", "MCP request failed", { retryable: false });
    }
    const output = mcpOutput(result);
    if (result.isError)
      throw new ToolError("io_error", "MCP tool returned an error", { output, retryable: false });
    return output;
  }
}

/** 固定工作区工具目录，拒绝完整名称冲突而不覆盖先前工具。 */
export function workspaceMcpTools(snapshot: McpWorkspaceSnapshot): McpTool[] {
  const tools = snapshot.servers.flatMap((server) =>
    server.tools.map((definition) => new McpTool(server, definition)),
  );
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error("MCP tool name collision");
    names.add(tool.name);
  }
  return tools;
}
