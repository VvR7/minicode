export { loadTraceConfig } from "./config.ts";
export type { TraceConfigResult } from "./config.ts";
export { TraceRecorder, runTraceDirectory } from "./recorder.ts";
export type { TraceRecordArgs } from "./recorder.ts";
export { REDACTED, isCredentialKey, redact, summarize, truncateFields } from "./redact.ts";
export { nodeTraceStorage } from "./storage.ts";
export {
  TRACE_FIELD_MAX_BYTES,
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_MAX_BYTES_MIN,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_QUEUE_EVENTS_MAX,
  TRACE_QUEUE_EVENTS_MIN,
  TRACE_RECORD_MAX_BYTES,
  TRACE_SCHEMA_VERSION,
  TRACE_SHUTDOWN_MS_DEFAULT,
  TRACE_SHUTDOWN_MS_MAX,
  TRACE_SHUTDOWN_MS_MIN,
  TRACE_TRUNCATED_RESERVE_BYTES,
  TraceKindSchema,
  TracePayloadModeSchema,
  TraceRecordSchema,
  TraceSourceSchema,
  TraceTargetSchema,
} from "./types.ts";
export type {
  TraceConfig,
  TraceKind,
  TracePayloadMode,
  TraceRecord,
  TraceRecordInput,
  TraceShutdownReport,
  TraceSource,
  TraceStorage,
  TraceStorageHandle,
  TraceTarget,
} from "./types.ts";
export { TraceWriter } from "./writer.ts";
