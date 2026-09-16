import { z } from "zod";
import type { Tool } from "./types.ts";

/** LLM 可消费的工具 JSON Schema 描述。 */
export interface LlmToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * 按名称注册工具的注册表。重复工具名视为编程错误，注册时即失败。
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool<Record<string, unknown>>>();

  register<Params>(tool: Tool<Params>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool as Tool<Record<string, unknown>>);
  }

  get(name: string): Tool<Record<string, unknown>> | undefined {
    return this.#tools.get(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  /** 导出全部工具的 LLM JSON Schema（Anthropic 兼容）。 */
  toolSchemas(): LlmToolDescription[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }
}
