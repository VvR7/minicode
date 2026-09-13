import { z } from "zod";

/**
 * provider 层的领域类型，与 IPC 事件层（@minicode/protocol）解耦。
 * provider 不依赖 EventBus、sessionId 或 runId，只输出标准化的流事件，
 * 由 AgentLoop 层负责把这些事件转换为 IPC 事件。
 */

/** 消息角色。MVP 只区分 user 与 assistant，system 由 stream 选项单独携带。 */
export const LlmRoleSchema = z.enum(["user", "assistant"]);
export type LlmRole = z.infer<typeof LlmRoleSchema>;

/** 文本内容块。 */
export const LlmTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});
export type LlmTextPart = z.infer<typeof LlmTextPartSchema>;

/** 助手请求的工具调用内容块。 */
export const LlmToolUsePartSchema = z.strictObject({
  type: z.literal("tool_use"),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
});
export type LlmToolUsePart = z.infer<typeof LlmToolUsePartSchema>;

/** 工具执行结果内容块。isError 标记失败结果，供模型作为 observation 继续处理。 */
export const LlmToolResultPartSchema = z.strictObject({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1).max(256),
  content: z.string().max(256 * 1024),
  isError: z.boolean().optional(),
});
export type LlmToolResultPart = z.infer<typeof LlmToolResultPartSchema>;

export const LlmContentPartSchema = z.discriminatedUnion("type", [
  LlmTextPartSchema,
  LlmToolUsePartSchema,
  LlmToolResultPartSchema,
]);
export type LlmContentPart = z.infer<typeof LlmContentPartSchema>;

/** 一条消息：角色 + 一组内容块。 */
export const LlmMessageSchema = z.strictObject({
  role: LlmRoleSchema,
  content: z.array(LlmContentPartSchema).min(1),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/** 归一化后的 token 用量统计。 */
export const LlmUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

/**
 * 归一化后的停止原因。
 * - end_turn：模型给出最终回答，不再调用工具
 * - tool_use：模型请求调用工具，AgentLoop 应执行工具后继续
 * - max_tokens：达到输出上限；若伴随 tool_use 则视为不完整调用
 * - stop_sequence：命中停止序列
 */
export const LlmFinishReasonSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
]);
export type LlmFinishReason = z.infer<typeof LlmFinishReasonSchema>;

/** 一个完整的工具调用。 */
export const LlmToolCallSchema = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
});
export type LlmToolCall = z.infer<typeof LlmToolCallSchema>;

/** 一次完整 LLM 调用的归一化结果。 */
export const LlmResponseSchema = z.strictObject({
  text: z.string(),
  toolCalls: z.array(LlmToolCallSchema),
  usage: LlmUsageSchema,
  finishReason: LlmFinishReasonSchema,
});
export type LlmResponse = z.infer<typeof LlmResponseSchema>;

/** 传给 LLM 的工具描述，inputSchema 为 JSON Schema。 */
export const LlmToolSchemaSchema = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type LlmToolSchema = z.infer<typeof LlmToolSchemaSchema>;

/** 可重试的瞬时失败类别，与 IPC 层 llm.retrying 事件的 reason 枚举一致。 */
export const LlmRetryReasonSchema = z.enum(["network", "rate_limit", "unavailable"]);
export type LlmRetryReason = z.infer<typeof LlmRetryReasonSchema>;

/**
 * provider 输出的标准化流事件。
 * - text_delta：增量文本；AgentLoop 转换为 llm.text_delta
 * - retrying：首 delta 前发生瞬时失败，即将重试；AgentLoop 转换为 llm.retrying
 * - completed：流结束，携带完整归一化响应；是每个成功调用的终结事件
 */
export const LlmStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text_delta"),
    text: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("retrying"),
    attempt: z.number().int().min(2),
    maxAttempts: z.number().int().min(2),
    delayMs: z.number().int().nonnegative(),
    reason: LlmRetryReasonSchema,
  }),
  z.strictObject({
    type: z.literal("completed"),
    response: LlmResponseSchema,
  }),
]);
export type LlmStreamEvent = z.infer<typeof LlmStreamEventSchema>;
