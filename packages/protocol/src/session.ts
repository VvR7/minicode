import { z } from "zod";

import { RunIdSchema, SessionIdSchema, SubscriptionIdSchema } from "./agent.ts";
import {
  JSON_RPC_VERSION,
  JsonRpcIdSchema,
  JsonRpcSessionErrorDataSchema,
  jsonRpcSuccessSchema,
} from "./json-rpc.ts";

/** Stage2 session 相关 RPC 方法名，集中定义避免各处硬编码字符串。 */
export const SESSION_CREATE_METHOD = "session.create" as const;
export const SESSION_GET_METHOD = "session.get" as const;
export const SESSION_LIST_METHOD = "session.list" as const;
export const SESSION_SEND_MESSAGE_METHOD = "session.sendMessage" as const;
export const SESSION_GET_HISTORY_METHOD = "session.getHistory" as const;
export const SESSION_SUBSCRIBE_METHOD = "session.subscribe" as const;

/** turn 标识：每个被接受的用户消息对应一个 turn。 */
export const TurnIdSchema = z.uuid();
export type TurnId = z.infer<typeof TurnIdSchema>;

/** 客户端生成的幂等键；同一 session 内重复发送相同 ID 与内容必须返回原 accepted 结果。 */
export const ClientMessageIdSchema = z.uuid();
export type ClientMessageId = z.infer<typeof ClientMessageIdSchema>;

/** session 的运行模式：chat 可多轮，one_shot 为 `mc --goal` 单轮。 */
export const SessionModeSchema = z.enum(["chat", "one_shot"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** session 状态机状态；corrupted 只读可诊断且不能 sendMessage。 */
export const SessionStatusSchema = z.enum(["idle", "running", "corrupted"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** 单条消息的文本上限，与 session.sendMessage content 一致。 */
export const MAX_SESSION_MESSAGE_CHARS = 32 * 1024;
/** 单个历史文本块上限；与 run.finished 最终文本及工具结果的审计上限一致。 */
export const MAX_HISTORY_TEXT_CHARS = 256 * 1024;
/** session.list 的默认与最大分页大小。 */
export const DEFAULT_SESSION_LIST_LIMIT = 50;
export const MAX_SESSION_LIST_LIMIT = 100;

/** session 当前 active run 的最小身份，供 TUI 发现并附着正在运行的 run。 */
export const ActiveRunSchema = z.strictObject({
  turnId: TurnIdSchema,
  runId: RunIdSchema,
});
export type ActiveRun = z.infer<typeof ActiveRunSchema>;

/** session 列表与详情共用的摘要结构。 */
export const SessionSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  mode: SessionModeSchema,
  status: SessionStatusSchema,
  title: z.string().max(256),
  workspaceRoot: z.string().min(1).max(4096),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  latestSessionSequence: z.number().int().nonnegative(),
  activeRun: ActiveRunSchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ---------------------------------------------------------------------------
// Task planning snapshot（#28 的 TaskManager 通过 task event 暴露的完整快照）
// ---------------------------------------------------------------------------

/** 任务状态；blocked 不在其中，它由 blockedBy 动态推导。 */
export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 完整任务快照，作为 task.created / task.updated 的 payload 以及历史恢复展示。 */
export const TaskSnapshotSchema = z.strictObject({
  id: z.number().int().positive(),
  subject: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  status: TaskStatusSchema,
  blocked: z.boolean(),
  blockedBy: z.array(z.number().int().positive()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

/** 一个 run 的最终任务图快照，供恢复后的 TUI 展示。 */
export const TaskGraphSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  tasks: z.array(TaskSnapshotSchema),
});
export type TaskGraphSnapshot = z.infer<typeof TaskGraphSnapshotSchema>;

// ---------------------------------------------------------------------------
// Session RPC params / results
// ---------------------------------------------------------------------------

export const SessionCreateParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1).max(4096),
});
export type SessionCreateParams = z.infer<typeof SessionCreateParamsSchema>;

export const SessionCreateResultSchema = z.strictObject({
  session: SessionSummarySchema,
});
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export const SessionGetParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
});
export type SessionGetParams = z.infer<typeof SessionGetParamsSchema>;

export const SessionGetResultSchema = z.strictObject({
  session: SessionSummarySchema,
});
export type SessionGetResult = z.infer<typeof SessionGetResultSchema>;

/**
 * session.list 参数。
 * workspaceRoot 省略表示不过滤；TUI 的默认查询必须显式传当前规范化 workspace。
 * cursor 是客户端不可解释的稳定游标，仅由上一页 nextCursor 原样回传。
 */
export const SessionListParamsSchema = z.strictObject({
  workspaceRoot: z.string().min(1).max(4096).optional(),
  includeOneShot: z.boolean().default(false),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(MAX_SESSION_LIST_LIMIT).default(DEFAULT_SESSION_LIST_LIMIT),
});
export type SessionListParams = z.infer<typeof SessionListParamsSchema>;

export const SessionListResultSchema = z.strictObject({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.string().min(1).max(512).optional(),
});
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

/** session.sendMessage 参数：content 先 trim，长度为 1..32768 字符。 */
export const SessionSendMessageParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
  clientMessageId: ClientMessageIdSchema,
  content: z.string().trim().min(1).max(MAX_SESSION_MESSAGE_CHARS),
});
export type SessionSendMessageParams = z.infer<typeof SessionSendMessageParamsSchema>;

export const SessionSendMessageResultSchema = z.strictObject({
  status: z.literal("accepted"),
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  runId: RunIdSchema,
});
export type SessionSendMessageResult = z.infer<typeof SessionSendMessageResultSchema>;

export const SessionGetHistoryParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
});
export type SessionGetHistoryParams = z.infer<typeof SessionGetHistoryParamsSchema>;

/** provider-neutral 的消息内容：文本、工具调用与工具结果。 */
export const HistoryTextContentSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().max(MAX_HISTORY_TEXT_CHARS),
});
export type HistoryTextContent = z.infer<typeof HistoryTextContentSchema>;

export const HistoryToolUseContentSchema = z.strictObject({
  type: z.literal("tool_use"),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
});
export type HistoryToolUseContent = z.infer<typeof HistoryToolUseContentSchema>;

export const HistoryToolResultContentSchema = z.strictObject({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1).max(256),
  content: z.string().max(256 * 1024),
  isError: z.boolean().optional(),
});
export type HistoryToolResultContent = z.infer<typeof HistoryToolResultContentSchema>;

export const HistoryContentSchema = z.discriminatedUnion("type", [
  HistoryTextContentSchema,
  HistoryToolUseContentSchema,
  HistoryToolResultContentSchema,
]);
export type HistoryContent = z.infer<typeof HistoryContentSchema>;

/** 历史消息：provider-neutral，不导出任何 provider 原生对象。 */
export const HistoryMessageSchema = z.strictObject({
  messageId: z.string().min(1).max(256),
  turnId: TurnIdSchema,
  runId: RunIdSchema,
  role: z.enum(["user", "assistant"]),
  timestamp: z.iso.datetime({ offset: true }),
  content: z.array(HistoryContentSchema).min(1),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/** 历史 turn 的终态；interrupted 表示 daemon 重启补偿。 */
export const HistoryTurnStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type HistoryTurnStatus = z.infer<typeof HistoryTurnStatusSchema>;

export const HistoryTurnReasonSchema = z.enum([
  "completed",
  "cancelled",
  "core_restarted",
  "config_error",
  "llm_error",
  "max_steps",
  "run_timeout",
  "invalid_llm_response",
  "event_store_error",
  "session_store_error",
  "internal_error",
]);
export type HistoryTurnReason = z.infer<typeof HistoryTurnReasonSchema>;

/** 校验 tool_use 与 tool_result 是否按 ID 完整配对（含尾部未配对检测）。 */
function hasCompleteToolPairing(messages: readonly HistoryMessage[]): boolean {
  const pending = new Set<string>();
  const seenToolUses = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        if (seenToolUses.has(block.id)) {
          return false;
        }
        seenToolUses.add(block.id);
        pending.add(block.id);
      } else if (block.type === "tool_result") {
        if (!pending.delete(block.toolUseId)) {
          return false;
        }
      }
    }
  }
  return pending.size === 0;
}

/**
 * 历史 turn。includedInContext=true 时必须是 succeeded 且工具调用配对完整，
 * 保证 history builder 只读取可直接进入下一轮上下文的完整轮次。
 */
export const HistoryTurnSchema = z
  .strictObject({
    turnId: TurnIdSchema,
    runId: RunIdSchema,
    clientMessageId: ClientMessageIdSchema,
    status: HistoryTurnStatusSchema,
    reason: HistoryTurnReasonSchema.optional(),
    acceptedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    includedInContext: z.boolean(),
    taskGraph: TaskGraphSnapshotSchema.optional(),
    messages: z.array(HistoryMessageSchema),
  })
  .superRefine((turn, ctx) => {
    for (const [index, message] of turn.messages.entries()) {
      if (message.turnId !== turn.turnId) {
        ctx.addIssue({
          code: "custom",
          message: "history message turnId must match its containing turn",
          path: ["messages", index, "turnId"],
        });
      }
      if (message.runId !== turn.runId) {
        ctx.addIssue({
          code: "custom",
          message: "history message runId must match its containing turn",
          path: ["messages", index, "runId"],
        });
      }
    }
    if (!turn.includedInContext) {
      return;
    }
    if (turn.status !== "succeeded") {
      ctx.addIssue({
        code: "custom",
        message: "only succeeded turns can be included in context",
        path: ["includedInContext"],
      });
    }
    if (!hasCompleteToolPairing(turn.messages)) {
      ctx.addIssue({
        code: "custom",
        message: "included turn has unpaired tool_use or tool_result messages",
        path: ["messages"],
      });
    }
  });
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

export const SessionGetHistoryResultSchema = z.strictObject({
  session: SessionSummarySchema,
  turns: z.array(HistoryTurnSchema),
  throughSessionSequence: z.number().int().nonnegative(),
});
export type SessionGetHistoryResult = z.infer<typeof SessionGetHistoryResultSchema>;

export const SessionSubscribeParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
  afterSequence: z.number().int().nonnegative().optional(),
});
export type SessionSubscribeParams = z.infer<typeof SessionSubscribeParamsSchema>;

export const SessionSubscribeResultSchema = z.strictObject({
  subscriptionId: SubscriptionIdSchema,
  sessionId: SessionIdSchema,
  latestSequence: z.number().int().nonnegative(),
  activeRun: ActiveRunSchema.optional(),
});
export type SessionSubscribeResult = z.infer<typeof SessionSubscribeResultSchema>;

// ---------------------------------------------------------------------------
// Session events（独立于 run sequence 的 sessionSequence 序列域）
// ---------------------------------------------------------------------------

/** session event 的公共字段：必须有 sessionId，禁止 daemon global scope。 */
const SessionEventBaseShape = {
  sessionId: SessionIdSchema,
  sessionSequence: z.number().int().positive(),
  timestamp: z.iso.datetime({ offset: true }),
  durable: z.literal(true),
};

function sessionEventSchema<const Type extends string, PayloadSchema extends z.ZodType>(
  type: Type,
  payload: PayloadSchema,
) {
  return z.strictObject({ ...SessionEventBaseShape, type: z.literal(type), payload });
}

/** turn_accepted 是其他 TUI 发现新 run 的权威信号。 */
export const SessionTurnAcceptedEventSchema = sessionEventSchema(
  "session.turn_accepted",
  z.strictObject({
    turnId: TurnIdSchema,
    runId: RunIdSchema,
    clientMessageId: ClientMessageIdSchema,
    userMessage: z.string().min(1).max(MAX_SESSION_MESSAGE_CHARS),
  }),
);
export type SessionTurnAcceptedEvent = z.infer<typeof SessionTurnAcceptedEventSchema>;

/** turn_finished 只能在审计历史提交成功后发布。 */
export const SessionTurnFinishedEventSchema = sessionEventSchema(
  "session.turn_finished",
  z.strictObject({
    turnId: TurnIdSchema,
    runId: RunIdSchema,
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    reason: HistoryTurnReasonSchema.optional(),
  }),
);
export type SessionTurnFinishedEvent = z.infer<typeof SessionTurnFinishedEventSchema>;

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionTurnAcceptedEventSchema,
  SessionTurnFinishedEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ---------------------------------------------------------------------------
// Request / response schemas（与现有 RPC 一样使用 strictObject）
// ---------------------------------------------------------------------------

function requestSchema<const Method extends string, ParamsSchema extends z.ZodType>(
  method: Method,
  params: ParamsSchema,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: JsonRpcIdSchema,
    method: z.literal(method),
    params,
  });
}

export const SessionCreateRequestSchema = requestSchema(
  SESSION_CREATE_METHOD,
  SessionCreateParamsSchema,
);
export const SessionCreateSuccessResponseSchema = jsonRpcSuccessSchema(SessionCreateResultSchema);
export const SessionGetRequestSchema = requestSchema(SESSION_GET_METHOD, SessionGetParamsSchema);
export const SessionGetSuccessResponseSchema = jsonRpcSuccessSchema(SessionGetResultSchema);
export const SessionListRequestSchema = requestSchema(SESSION_LIST_METHOD, SessionListParamsSchema);
export const SessionListSuccessResponseSchema = jsonRpcSuccessSchema(SessionListResultSchema);
export const SessionSendMessageRequestSchema = requestSchema(
  SESSION_SEND_MESSAGE_METHOD,
  SessionSendMessageParamsSchema,
);
export const SessionSendMessageSuccessResponseSchema = jsonRpcSuccessSchema(
  SessionSendMessageResultSchema,
);
export const SessionGetHistoryRequestSchema = requestSchema(
  SESSION_GET_HISTORY_METHOD,
  SessionGetHistoryParamsSchema,
);
export const SessionGetHistorySuccessResponseSchema = jsonRpcSuccessSchema(
  SessionGetHistoryResultSchema,
);
export const SessionSubscribeRequestSchema = requestSchema(
  SESSION_SUBSCRIBE_METHOD,
  SessionSubscribeParamsSchema,
);
export const SessionSubscribeSuccessResponseSchema = jsonRpcSuccessSchema(
  SessionSubscribeResultSchema,
);

// ---------------------------------------------------------------------------
// 结构化错误 data
// ---------------------------------------------------------------------------

/**
 * session 类错误的 data 只允许安全、类型化的诊断字段，
 * 不允许出现路径、prompt 或底层异常信息。
 */
export const SessionErrorDataSchema = JsonRpcSessionErrorDataSchema;
export type SessionErrorData = z.infer<typeof SessionErrorDataSchema>;

/** 供 Core handler 复用的 session 错误码名称。 */
export const SessionErrorCode = {
  sessionNotFound: "session_not_found",
  sessionBusy: "session_busy",
  sessionCorrupted: "session_corrupted",
  contextLimitExceeded: "context_limit_exceeded",
  oneShotNotResumable: "one_shot_not_resumable",
} as const;
export type SessionErrorCode = (typeof SessionErrorCode)[keyof typeof SessionErrorCode];
