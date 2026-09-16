import { z } from "zod";

import { RunIdSchema, SessionIdSchema } from "./agent.ts";
import { JSON_RPC_VERSION, JsonRpcIdSchema, jsonRpcSuccessSchema } from "./json-rpc.ts";

export const PERMISSION_RESPOND_METHOD = "permission.respond" as const;
export const MAX_PERMISSION_PATH_CHARS = 4096;
export const MAX_PERMISSION_PREVIEW_CHARS = 1024;
export const MAX_PERMISSION_COMMAND_CHARS = 8 * 1024;

export const PermissionRequestIdSchema = z.uuid();
export type PermissionRequestId = z.infer<typeof PermissionRequestIdSchema>;

export const PermissionDecisionSchema = z.enum([
  "allow_once",
  "always_allow",
  "deny_once",
  "always_deny",
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRiskCategorySchema = z.enum([
  "write",
  "edit",
  "bash:workspace-mutation",
  "bash:network",
  "bash:process-execution",
  "bash:other",
]);
export type PermissionRiskCategory = z.infer<typeof PermissionRiskCategorySchema>;

export const PermissionSourceSchema = z.enum(["policy", "session_cache", "user"]);
export type PermissionSource = z.infer<typeof PermissionSourceSchema>;

export const ToolFailureCategorySchema = z.enum([
  "schema_error",
  "permission_denied",
  "timeout",
  "runtime_error",
  "rate_limited",
  "cancelled",
]);
export type ToolFailureCategory = z.infer<typeof ToolFailureCategorySchema>;

const PermissionPathSchema = z.string().min(1).max(MAX_PERMISSION_PATH_CHARS);

/** 审批事件中的有界展示摘要；不承载完整 write 内容。 */
export const PermissionRequestSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read"),
    path: PermissionPathSchema,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  z.strictObject({
    kind: z.literal("write"),
    path: PermissionPathSchema,
    contentBytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024),
    previewStart: z.string().max(MAX_PERMISSION_PREVIEW_CHARS),
    previewEnd: z.string().max(MAX_PERMISSION_PREVIEW_CHARS),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    path: PermissionPathSchema,
    oldTextPreview: z.string().max(MAX_PERMISSION_PREVIEW_CHARS),
    newTextPreview: z.string().max(MAX_PERMISSION_PREVIEW_CHARS),
    replaceAll: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("bash"),
    command: z.string().min(1).max(MAX_PERMISSION_COMMAND_CHARS),
    timeoutSeconds: z.number().int().min(1).max(120),
  }),
]);
export type PermissionRequestSummary = z.infer<typeof PermissionRequestSummarySchema>;

export const PermissionRespondParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  permissionRequestId: PermissionRequestIdSchema,
  decision: PermissionDecisionSchema,
});
export type PermissionRespondParams = z.infer<typeof PermissionRespondParamsSchema>;

export const PermissionRespondResultSchema = z.strictObject({
  outcome: z.enum(["accepted", "already_resolved", "not_found"]),
});
export type PermissionRespondResult = z.infer<typeof PermissionRespondResultSchema>;

export const PermissionRespondRequestSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.literal(PERMISSION_RESPOND_METHOD),
  params: PermissionRespondParamsSchema,
});
export const PermissionRespondSuccessResponseSchema = jsonRpcSuccessSchema(
  PermissionRespondResultSchema,
);
