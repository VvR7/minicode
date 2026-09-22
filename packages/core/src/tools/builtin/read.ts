import { z } from "zod";
import { readUtf8File, resolveToolPath, throwIfAborted } from "../fs-safety.ts";
import type { Tool, ToolExecutionContext, ToolOutput } from "../types.ts";

import { DEFAULT_MAX_LINES, truncateHead } from "../output-budget.ts";

const DEFAULT_READ_LIMIT = DEFAULT_MAX_LINES;

export const ReadParamsSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(DEFAULT_READ_LIMIT).optional(),
});
export type ReadParams = z.infer<typeof ReadParamsSchema>;

/** 按 1-based 行偏移读取 UTF-8 文本，并把结果限制在 2000 行 / 50 KiB。 */
export class ReadTool implements Tool<ReadParams> {
  readonly name = "read";
  readonly description =
    `Read UTF-8 text lines from a path. offset is 1-based and limit defaults to ${DEFAULT_READ_LIMIT} lines.`;
  readonly inputSchema = ReadParamsSchema;

  /** 读取指定行窗口；绝对路径和外部符号链接可用，但显式 `..` 会被拒绝。 */
  async execute(params: ReadParams, context: ToolExecutionContext): Promise<ToolOutput> {
    throwIfAborted(context.signal);
    const { text } = await readUtf8File(resolveToolPath(context.workspaceRoot, params.path));
    throwIfAborted(context.signal);
    const offset = params.offset ?? 1;
    const limit = params.limit ?? DEFAULT_READ_LIMIT;
    const lines = text.split(/\r?\n/u);
    // 显式 limit 是用户选择的行窗口；默认窗口则由统一截断函数报告容量截断。
    const selected = (
      params.limit === undefined
        ? lines.slice(offset - 1)
        : lines.slice(offset - 1, offset - 1 + limit)
    ).join("\n");
    return truncateHead(selected);
  }
}
