import { z } from "zod";
import { readUtf8File, resolveToolPath, throwIfAborted } from "../fs-safety.ts";
import { ToolError, type Tool, type ToolExecutionContext, type ToolOutput } from "../types.ts";
import { MAX_WRITE_BYTES, WriteTool } from "./file-write.ts";

export const EditParamsSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});
export type EditParams = z.infer<typeof EditParamsSchema>;

/** 对 UTF-8 文件执行精确文本替换，并复用 write 的原子提交。 */
export class EditTool implements Tool<EditParams> {
  readonly executeMode = "serial" as const;
  readonly name = "edit";
  readonly description =
    "Atomically replace an exact text fragment. A non-unique match requires replaceAll=true.";
  readonly inputSchema = EditParamsSchema;
  readonly #writer = new WriteTool();

  /** 校验匹配数量后替换一次或全部；未匹配和歧义均返回确定性错误。 */
  async execute(params: EditParams, context: ToolExecutionContext): Promise<ToolOutput> {
    throwIfAborted(context.signal);
    const target = resolveToolPath(context.workspaceRoot, params.path);
    const { text } = await readUtf8File(target);
    const matches = text.split(params.oldText).length - 1;
    if (matches === 0) throw new ToolError("no_match", "oldText was not found");
    if (matches > 1 && params.replaceAll !== true) {
      throw new ToolError("ambiguous_match", "oldText matches more than once; set replaceAll=true");
    }
    const content =
      params.replaceAll === true
        ? text.split(params.oldText).join(params.newText)
        : text.replace(params.oldText, () => params.newText);
    if (new TextEncoder().encode(content).byteLength > MAX_WRITE_BYTES) {
      throw new ToolError("invalid_params", "edited content exceeds 1 MiB");
    }
    return this.#writer.execute({ path: target, content }, context);
  }
}
