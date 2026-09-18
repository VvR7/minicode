import { join } from "node:path";
import { z } from "zod";
import { nodeSessionStorage, type SessionStorage } from "../session/storage.ts";

/** 每次 run 读取的用户规则快照；只加载全局与项目根两处。 */
export const ContextFilesSchema = z.strictObject({ global: z.string(), project: z.string() });
export type ContextFiles = z.infer<typeof ContextFilesSchema>;

/** 读取 UTF-8 规则文件；不存在和空白忽略，其余错误交给编排层报告。 */
export async function loadContextFiles(
  homeDirectory: string,
  workspaceRoot: string,
  storage: Pick<SessionStorage, "readFile"> = nodeSessionStorage,
): Promise<ContextFiles> {
  const [global, project] = await Promise.all([
    storage.readFile(join(homeDirectory, "CONTEXT.md")),
    storage.readFile(join(workspaceRoot, "CONTEXT.md")),
  ]);
  return ContextFilesSchema.parse({ global: global?.trim() ?? "", project: project?.trim() ?? "" });
}
