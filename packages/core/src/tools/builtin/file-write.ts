import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { nodeErrorCode, resolveToolPath, throwIfAborted, toFileToolError } from "../fs-safety.ts";
import { ToolError, type Tool, type ToolExecutionContext, type ToolOutput } from "../types.ts";

export const MAX_WRITE_BYTES = 1024 * 1024;
export const WriteParamsSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z
    .string()
    .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_WRITE_BYTES, {
      message: "content exceeds 1 MiB",
    }),
});
export type WriteParams = z.infer<typeof WriteParamsSchema>;

/** 原子创建或覆盖 UTF-8 文本文件，并按需创建父目录。 */
export class WriteTool implements Tool<WriteParams> {
  readonly executeMode = "serial" as const;
  readonly name = "write";
  readonly description =
    "Create or atomically overwrite a UTF-8 text file, creating parent directories.";
  readonly inputSchema = WriteParamsSchema;

  /** 把内容写入同目录临时文件后 rename，避免暴露半写入文件。 */
  async execute(params: WriteParams, context: ToolExecutionContext): Promise<ToolOutput> {
    throwIfAborted(context.signal);
    const lexicalTarget = resolveToolPath(context.workspaceRoot, params.path);
    let target: string;
    try {
      // 已存在目标先解析链接，确保原子 rename 修改目标文件而不是替换链接本身。
      target = await realpath(lexicalTarget);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw toFileToolError(error, "resolve file");
      target = lexicalTarget;
    }
    const parent = dirname(target);
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await mkdir(parent, { recursive: true });
      throwIfAborted(context.signal);
      await writeFile(temporary, params.content, { encoding: "utf8", flag: "wx" });
      throwIfAborted(context.signal);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof ToolError) throw error;
      throw toFileToolError(error, "write file");
    }
    return { content: `wrote ${new TextEncoder().encode(params.content).byteLength} bytes` };
  }
}
