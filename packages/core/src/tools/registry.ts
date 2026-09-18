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

  /** 按名称注册工具，拒绝覆盖已注册能力。 */
  register<Params>(tool: Tool<Params>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool as Tool<Record<string, unknown>>);
  }

  /** 返回指定工具，未知名称由调用层处理。 */
  get(name: string): Tool<Record<string, unknown>> | undefined {
    return this.#tools.get(name);
  }

  /** 返回已注册工具数量。 */
  get size(): number {
    return this.#tools.size;
  }

  /** 导出全部工具的 LLM JSON Schema（Anthropic 兼容）。 */
  toolSchemas(): LlmToolDescription[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool.llmInputSchema ?? (z.toJSONSchema(tool.inputSchema) as Record<string, unknown>),
    }));
  }
}
