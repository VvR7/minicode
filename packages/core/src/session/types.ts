import type {
  ActiveRun,
  ClientMessageId,
  HistoryMessage,
  HistoryTurn,
  HistoryTurnReason,
  RunId,
  SessionEvent,
  SessionMode,
  SessionStatus,
  SessionSummary,
  TaskGraphSnapshot,
  TurnId,
} from "@minicode/protocol";
import {
  ActiveRunSchema,
  ClientMessageIdSchema,
  HistoryMessageSchema,
  HistoryTurnReasonSchema,
  MAX_SESSION_MESSAGE_CHARS,
  RunIdSchema,
  SessionEventSchema,
  SessionIdSchema,
  SessionModeSchema,
  TaskGraphSnapshotSchema,
  TurnIdSchema,
} from "@minicode/protocol";
import { z } from "zod";

/** 磁盘格式版本；未知版本一律视为 corrupted，不做兼容猜测。 */
export const SESSION_SCHEMA_VERSION = 1 as const;

/** 单条 note 的字符上限；超出返回结构化错误而不是截断。 */
export const MAX_NOTE_CHARS = 16 * 1024;
/** notes.md 的总字节上限。 */
export const MAX_NOTES_BYTES = 256 * 1024;

/** meta.json：只保存静态身份与可安全缓存的展示字段。 */
export const SessionMetaSchema = z.strictObject({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: SessionIdSchema,
  mode: SessionModeSchema,
  workspaceRoot: z.string().min(1).max(4096),
  title: z.string().max(256),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

const HistoryRecordBaseShape = {
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  recordId: z.uuid(),
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  runId: RunIdSchema,
  timestamp: z.iso.datetime({ offset: true }),
};

/** history.jsonl 的 turn.accepted 记录：幂等键与原始用户消息的唯一来源。 */
export const TurnAcceptedRecordSchema = z.strictObject({
  ...HistoryRecordBaseShape,
  kind: z.literal("turn.accepted"),
  clientMessageId: ClientMessageIdSchema,
  userMessage: z.string().min(1).max(MAX_SESSION_MESSAGE_CHARS),
});
export type TurnAcceptedRecord = z.infer<typeof TurnAcceptedRecordSchema>;

/** turn.completed 允许的终态；running 只存在于内存中的未完成 turn。 */
export const CompletedStatusSchema = z.enum(["succeeded", "failed", "cancelled", "interrupted"]);
export type CompletedStatus = z.infer<typeof CompletedStatusSchema>;

/** history.jsonl 的 turn.completed 记录：完整 provider-neutral 审计内容。 */
export const TurnCompletedRecordSchema = z
  .strictObject({
    ...HistoryRecordBaseShape,
    kind: z.literal("turn.completed"),
    status: CompletedStatusSchema,
    reason: HistoryTurnReasonSchema.optional(),
    messages: z.array(HistoryMessageSchema),
    includedInContext: z.boolean(),
    model: z.string().min(1).max(256),
    taskGraph: TaskGraphSnapshotSchema.optional(),
  })
  .superRefine((record, ctx) => {
    // succeeded 才允许进入下一轮上下文；其余终态只能是审计记录。
    if (record.includedInContext && record.status !== "succeeded") {
      ctx.addIssue({
        code: "custom",
        message: "only succeeded completions may be included in context",
        path: ["includedInContext"],
      });
    }
  });
export type TurnCompletedRecord = z.infer<typeof TurnCompletedRecordSchema>;

export const HistoryRecordSchema = z.discriminatedUnion("kind", [
  TurnAcceptedRecordSchema,
  TurnCompletedRecordSchema,
]);
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

/** session-events.jsonl 的持久记录：包装 SessionEvent 以携带 schemaVersion。 */
export const SessionEventRecordSchema = z.strictObject({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  recordId: z.uuid(),
  event: SessionEventSchema,
});
export type SessionEventRecord = z.infer<typeof SessionEventRecordSchema>;

/** 合法 turn.accepted 但缺少 completed 时，恢复层返回的待补偿中断。 */
export interface PendingInterruption {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly clientMessageId: ClientMessageId;
  readonly acceptedAt: string;
  readonly userMessage: string;
}

/**
 * 一次 session 加载后的内存快照。
 * status/activeRun 由合法 history 与 session event 推导，不信任可能过期的 meta 缓存字段。
 */
export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly status: SessionStatus;
  readonly activeRun?: ActiveRun;
  readonly latestSessionSequence: number;
  /** 以合法 journal 为准计算的展示更新时间。 */
  readonly updatedAt: string;
  readonly turns: readonly HistoryTurn[];
  readonly pendingInterruptions: readonly PendingInterruption[];
  /** 完整 session journal，供订阅回放与恢复使用。 */
  readonly sessionEvents: readonly SessionEvent[];
  readonly notes: string;
}

/** session.list 的过滤与分页输入。 */
export interface SessionListOptions {
  /** 省略表示不过滤；否则按规范化 workspaceRoot 精确匹配。 */
  readonly workspaceRoot?: string;
  readonly includeOneShot?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionListPage {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

/** 创建 session 的输入。 */
export interface CreateSessionOptions {
  readonly mode: SessionMode;
  readonly workspaceRoot: string;
}

export type SessionStoreFailureCode =
  | "session_not_found"
  | "session_corrupted"
  | "io_error"
  | "invalid_input"
  | "idempotency_conflict"
  | "duplicate_turn"
  | "unknown_turn"
  | "invalid_cursor"
  | "note_invalid"
  | "note_limit_exceeded";

/** 存储层错误：只携带稳定错误码与安全短消息，不暴露路径或底层异常。 */
export interface SessionStoreFailure {
  readonly code: SessionStoreFailureCode;
  readonly message: string;
}

export type SessionStoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SessionStoreFailure };

/** appendAccepted 的返回值；idempotent=true 表示命中了同一 clientMessageId 的重试。 */
export interface AcceptedTurn {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly acceptedAt: string;
  readonly idempotent: boolean;
}

/** appendAccepted 的输入；身份由调用方（#29 编排层）分配。 */
export interface AcceptTurnInput {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly clientMessageId: ClientMessageId;
  readonly userMessage: string;
}

/** appendCompleted 的输入；身份必须与已接受的 turn 一致。 */
export interface CompleteTurnInput {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly status: CompletedStatus;
  readonly reason?: HistoryTurnReason;
  readonly messages: readonly HistoryMessage[];
  readonly model: string;
  readonly taskGraph?: TaskGraphSnapshot;
}

export {
  ActiveRunSchema,
  ClientMessageIdSchema,
  RunIdSchema,
  SessionIdSchema,
  SessionModeSchema,
  TurnIdSchema,
};
