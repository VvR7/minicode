import { z } from "zod";

import { JSON_RPC_VERSION, JsonRpcIdSchema, jsonRpcSuccessSchema } from "./json-rpc.ts";

export const SKILL_LIST_METHOD = "skill.list" as const;

/** Skill 目录只传递发现信息；正文由显式调用或 read 工具加载。 */
export const SkillDescriptionSchema = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  path: z.string().min(1).max(4096),
});
export type SkillDescription = z.infer<typeof SkillDescriptionSchema>;

/** 无效扩展文件的有界诊断，不包含文件正文或底层异常堆栈。 */
export const ExtensionDiagnosticSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1024),
});
export type ExtensionDiagnostic = z.infer<typeof ExtensionDiagnosticSchema>;

/** 目录查询不创建 session/turn/run，Core 负责规范化 workspaceRoot。 */
export const SkillListParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1).max(4096),
});
export type SkillListParams = z.infer<typeof SkillListParamsSchema>;

export const SkillListResultSchema = z.strictObject({
  skills: z.array(SkillDescriptionSchema),
  diagnostics: z.array(ExtensionDiagnosticSchema),
});
export type SkillListResult = z.infer<typeof SkillListResultSchema>;

export const SkillListRequestSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.literal(SKILL_LIST_METHOD),
  params: SkillListParamsSchema,
});
export const SkillListSuccessResponseSchema = jsonRpcSuccessSchema(SkillListResultSchema);
