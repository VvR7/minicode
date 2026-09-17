import { z } from "zod";
import {
  CompactionReasonSchema,
  CompactionResultSchema,
  ContextMessageMetadataSchema,
  RunIdSchema,
} from "@minicode/protocol";
import { LlmMessageSchema, LlmUsageSchema } from "../llm/types.ts";

/** 内部上下文条目保留身份；provider 转换时只发送 role/content。 */
export const ContextEntrySchema = LlmMessageSchema.extend({
  messageId: z.string().min(1).max(256),
  runId: RunIdSchema.optional(),
  metadata: ContextMessageMetadataSchema.optional(),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/** 完整 checkpoint；摘要成功或确定性隐藏兜底均可恢复。 */
export const CompactionCheckpointSchema = CompactionResultSchema.extend({
  reason: CompactionReasonSchema,
  summary: z
    .string()
    .min(1)
    .max(256 * 1024),
  readFiles: z.array(z.string()),
  modifiedFiles: z.array(z.string()),
  usage: LlmUsageSchema,
});
export type CompactionCheckpoint = z.infer<typeof CompactionCheckpointSchema>;
