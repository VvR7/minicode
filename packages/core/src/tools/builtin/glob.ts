import { z } from "zod";
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveSafePath, walkFiles } from "../fs-safety.ts";
import { ToolError, type Tool, type ToolExecutionContext, type ToolOutput } from "../types.ts";

export const GlobParamsSchema = z.strictObject({
  pattern: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096).optional(),
});
export type GlobParams = z.infer<typeof GlobParamsSchema>;

/** 在 workspace 内按 glob 模式查找文件，返回相对 workspace 根的有序路径列表。 */
export class GlobTool implements Tool<GlobParams> {
  readonly name = "glob";
  readonly description = "Find files matching a glob pattern within the workspace.";
  readonly inputSchema = GlobParamsSchema;

  async execute(params: GlobParams, context: ToolExecutionContext): Promise<ToolOutput> {
    const base = params.path ?? ".";
    const basePath = await resolveSafePath(context.workspaceRoot, base);
    await assertDirectory(basePath);

    const glob = new Bun.Glob(params.pattern);
    const files = await walkFiles(basePath, context.signal);
    const matches = files
      .map((file) => relative(context.workspaceRoot, join(basePath, file)))
      .filter((path) => glob.match(path))
      .sort();
    return { content: matches.join("\n") };
  }
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new ToolError("invalid_params", "path must be a directory");
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError("not_found", "path not found");
  }
}
