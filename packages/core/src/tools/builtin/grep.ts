import { z } from "zod";
import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, relative } from "node:path";
import { readTextFileSafe, resolveSafePath, walkFiles } from "../fs-safety.ts";
import {
  MAX_TOOL_RESULT_BYTES,
  ToolError,
  type Tool,
  type ToolExecutionContext,
  type ToolOutput,
} from "../types.ts";

export const GrepParamsSchema = z.strictObject({
  pattern: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096).optional(),
});
export type GrepParams = z.infer<typeof GrepParamsSchema>;

/** 在 workspace 内按正则搜索文本文件，输出 `path:line:content` 匹配行。 */
export class GrepTool implements Tool<GrepParams> {
  readonly name = "grep";
  readonly description =
    "Search for a regular expression pattern in text files within the workspace.";
  readonly inputSchema = GrepParamsSchema;

  async execute(params: GrepParams, context: ToolExecutionContext): Promise<ToolOutput> {
    let regex: RegExp;
    try {
      regex = new RegExp(params.pattern);
    } catch {
      throw new ToolError("invalid_params", "invalid regular expression pattern");
    }

    const base = params.path ?? ".";
    const basePath = await resolveSafePath(context.workspaceRoot, base);
    const files = await this.#collectFiles(basePath, context);

    const lines: string[] = [];
    for (const file of files) {
      throwIfAborted(context.signal);
      const fullPath = file === "" ? basePath : join(basePath, file);
      const displayPath = file === "" ? relative(context.workspaceRoot, basePath) : file;
      let text: string;
      try {
        text = (await readTextFileSafe(fullPath, MAX_TOOL_RESULT_BYTES)).text;
      } catch (error) {
        // 跳过 binary、无效 UTF-8 与扫描期间消失的文件，其余错误向上传播。
        if (
          error instanceof ToolError &&
          (error.code === "binary_file" ||
            error.code === "invalid_utf8" ||
            error.code === "not_found")
        ) {
          continue;
        }
        throw error;
      }
      text.split("\n").forEach((line, index) => {
        if (regex.test(line)) {
          lines.push(`${displayPath}:${index + 1}:${line}`);
        }
      });
    }
    return { content: lines.join("\n") };
  }

  async #collectFiles(basePath: string, context: ToolExecutionContext): Promise<string[]> {
    let info: Stats;
    try {
      info = await stat(basePath);
    } catch {
      throw new ToolError("not_found", "path not found");
    }
    if (info.isFile()) {
      return [""];
    }
    if (info.isDirectory()) {
      return walkFiles(basePath, context.signal);
    }
    throw new ToolError("invalid_params", "path must be a file or directory");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolError("aborted", "tool call aborted");
  }
}
