import { z } from "zod";
import { readTextFileSafe, resolveSafePath } from "../fs-safety.ts";
import {
  MAX_TOOL_RESULT_BYTES,
  type Tool,
  type ToolExecutionContext,
  type ToolOutput,
} from "../types.ts";

export const ReadFileParamsSchema = z.strictObject({
  path: z.string().min(1).max(4096),
});
export type ReadFileParams = z.infer<typeof ReadFileParamsSchema>;

/** 读取 workspace 内的文本文件；拒绝绝对路径、..、symlink 逃逸、binary 与无效 UTF-8。 */
export class ReadFileTool implements Tool<ReadFileParams> {
  readonly name = "read_file";
  readonly description =
    "Read the text content of a file. The path must be relative to the workspace root.";
  readonly inputSchema = ReadFileParamsSchema;

  async execute(params: ReadFileParams, context: ToolExecutionContext): Promise<ToolOutput> {
    const target = await resolveSafePath(context.workspaceRoot, params.path);
    const { text, outputBytes, truncated } = await readTextFileSafe(target, MAX_TOOL_RESULT_BYTES);
    return { content: text, truncated, outputBytes };
  }
}
