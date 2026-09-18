import { z } from "zod";

import { type LlmToolSchema, LlmToolSchemaSchema } from "../llm/types.ts";
import { SkillCatalogSchema, type SkillCatalog } from "../skills/loader.ts";
import type { ContextFiles } from "../memory/context-loader.ts";

/** preflight 和模型执行共用的提示词/工具目录，不含 run 级可变状态。 */
export const RunSnapshotSchema = z.strictObject({
  systemPrompt: z.string(),
  toolSchemas: z.array(LlmToolSchemaSchema),
  skillCatalog: SkillCatalogSchema.optional(),
});
export type RunSnapshot = Readonly<Omit<z.infer<typeof RunSnapshotSchema>, "toolSchemas">> & {
  readonly toolSchemas: readonly LlmToolSchema[];
};

/** 在分配 turn/run 之前准备扩展能力；workspace 来自已规范化 session。 */
export interface RunSnapshotRequest {
  readonly workspaceRoot: string;
  readonly notes: string;
  readonly files: ContextFiles;
}

/** 校验并复制工具定义，避免后续修改来源目录影响已接受 run 的预算和请求。 */
export function createRunSnapshot(
  systemPrompt: string,
  toolSchemas: readonly LlmToolSchema[],
  skillCatalog?: SkillCatalog,
): RunSnapshot {
  const parsed = RunSnapshotSchema.parse({
    systemPrompt,
    toolSchemas: structuredClone(toolSchemas),
    ...(skillCatalog === undefined ? {} : { skillCatalog: structuredClone(skillCatalog) }),
  });
  return Object.freeze({
    ...parsed,
    toolSchemas: Object.freeze(parsed.toolSchemas),
  });
}
