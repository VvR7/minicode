import { RunIdSchema, SessionIdSchema } from "@minicode/protocol";
import { z } from "zod";

/** Trace 磁盘格式版本；未知版本一律拒绝。 */
export const TRACE_SCHEMA_VERSION = 1 as const;

/** Trace 记录的来源边界。 */
export const TraceSourceSchema = z.enum(["CLIENT", "CORE", "LLM"]);
export type TraceSource = z.infer<typeof TraceSourceSchema>;

/** Trace 记录的目标边界。 */
export const TraceTargetSchema = z.enum(["CLIENT", "CORE", "LLM"]);
export type TraceTarget = z.infer<typeof TraceTargetSchema>;

/** Trace 记录类型，覆盖 IPC、Core、LLM 与截断诊断。 */
export const TraceKindSchema = z.enum([
  "ipc.request_received",
  "ipc.response_queued",
  "ipc.response_sent",
  "ipc.error",
  "core.event_persisted",
  "llm.request",
  "llm.stream_delta",
  "llm.response",
  "llm.error",
  "llm.cancelled",
  "trace.truncated",
]);
export type TraceKind = z.infer<typeof TraceKindSchema>;

/** 单条 Trace 记录的严格版本化 schema；sequence 由 writer 连续分配。 */
export const TraceRecordSchema = z.strictObject({
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  observedAt: z.iso.datetime({ offset: true }),
  source: TraceSourceSchema,
  target: TraceTargetSchema,
  kind: TraceKindSchema,
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  step: z.number().int().nonnegative().optional(),
  connectionId: z.string().min(1).max(256).optional(),
  requestId: z.string().min(1).max(256).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TraceRecord = z.infer<typeof TraceRecordSchema>;

/** 记录器写入的记录输入；sequence 由 writer 统一分配，避免并发交错。 */
export type TraceRecordInput = Omit<TraceRecord, "sequence">;

/** Trace payload 模式：summary 只保留结构/计数/名称/用量，full 允许业务 payload。 */
export const TracePayloadModeSchema = z.enum(["summary", "full"]);
export type TracePayloadMode = z.infer<typeof TracePayloadModeSchema>;

/** 一次 run 的 Trace 配置。 */
export interface TraceConfig {
  readonly enabled: boolean;
  readonly payload: TracePayloadMode;
  readonly queueEvents: number;
  readonly maxBytes: number;
  readonly shutdownMs: number;
}

/** 队列事件数默认值与边界。 */
export const TRACE_QUEUE_EVENTS_DEFAULT = 1024;
export const TRACE_QUEUE_EVENTS_MIN = 16;
export const TRACE_QUEUE_EVENTS_MAX = 65_536;

/** 文件字节上限默认值与最小值。 */
export const TRACE_MAX_BYTES_DEFAULT = 33_554_432;
export const TRACE_MAX_BYTES_MIN = 1024 * 1024;

/** shutdown 等待时长默认值与边界。 */
export const TRACE_SHUTDOWN_MS_DEFAULT = 2000;
export const TRACE_SHUTDOWN_MS_MIN = 100;
export const TRACE_SHUTDOWN_MS_MAX = 30_000;

/** 单字段最大字节数。 */
export const TRACE_FIELD_MAX_BYTES = 64 * 1024;
/** 单记录最大字节数。 */
export const TRACE_RECORD_MAX_BYTES = 256 * 1024;
/** 为 trace.truncated 记录预留的空间。 */
export const TRACE_TRUNCATED_RESERVE_BYTES = 1024;

/** writer 关闭后的诊断报告；任何失败都不抛给调用方。 */
export interface TraceShutdownReport {
  readonly bytesWritten: number;
  readonly recordsWritten: number;
  /** shutdown 超时后仍未刷盘的记录数。 */
  readonly pendingRecords: number;
  /** 因队列溢出、文件上限或序列化失败而丢弃的记录数。 */
  readonly droppedRecords: number;
  readonly droppedBytes: number;
  readonly timedOut: boolean;
  readonly writeFailed: boolean;
}

/** Trace 写入的最小存储契约，测试可注入内存/故障实现。 */
export interface TraceStorage {
  /** 递归创建目录并收紧 0700。 */
  ensureDirectory(path: string): Promise<void>;
  /** 以追加模式打开 trace 文件并收紧 0600。 */
  openAppend(path: string): Promise<TraceStorageHandle>;
}

export interface TraceStorageHandle {
  write(text: string): Promise<void>;
  close(): Promise<void>;
}
