import { join } from "node:path";
import type { RunId, SessionId } from "@minicode/protocol";
import { redact, summarize, truncateFields } from "./redact.ts";
import {
  TRACE_SCHEMA_VERSION,
  type TraceConfig,
  type TraceKind,
  type TraceRecordInput,
  type TraceShutdownReport,
  type TraceSource,
  type TraceStorage,
  type TraceTarget,
} from "./types.ts";
import { TraceWriter } from "./writer.ts";

/** 记录单条 Trace 的可选上下文与业务数据。 */
export interface TraceRecordArgs {
  readonly source: TraceSource;
  readonly target: TraceTarget;
  readonly kind: TraceKind;
  readonly step?: number;
  readonly connectionId?: string;
  readonly requestId?: string;
  readonly durationMs?: number;
  readonly data?: Record<string, unknown>;
}

/** 计算某个 run 的 trace 目录，与 SessionStore 的路径规则保持一致。 */
export function runTraceDirectory(
  homeDirectory: string,
  sessionId: SessionId,
  runId: RunId,
): string {
  return join(homeDirectory, "sessions", sessionId, "runs", runId);
}

/**
 * 单个 run 的 Trace 记录器：应用 summary/full 转换、脱敏、字段截断后
 * 交给有界 writer 异步落盘。所有操作 best-effort，绝不抛出影响 run。
 */
export class TraceRecorder {
  readonly #sessionId: SessionId;
  readonly #runId: RunId;
  readonly #config: TraceConfig;
  readonly #writer: TraceWriter;
  readonly #now: () => string;

  constructor(
    sessionId: SessionId,
    runId: RunId,
    config: TraceConfig,
    storage: TraceStorage,
    directory: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#sessionId = sessionId;
    this.#runId = runId;
    this.#config = config;
    this.#writer = new TraceWriter(sessionId, runId, config, storage, directory);
    this.#now = now;
  }

  /** 幂等启动后台 writer。 */
  start(): void {
    this.#writer.start();
  }

  /** 记录一条 Trace；enabled=false 或任何处理失败时静默忽略。 */
  record(args: TraceRecordArgs): void {
    if (!this.#config.enabled) {
      return;
    }
    let data: unknown = args.data;
    try {
      data = this.#config.payload === "summary" ? summarize(args.data) : args.data;
      data = redact(data);
      data = truncateFields(data);
    } catch {
      return;
    }

    const record: TraceRecordInput = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      observedAt: this.#now(),
      source: args.source,
      target: args.target,
      kind: args.kind,
      sessionId: this.#sessionId,
      runId: this.#runId,
      ...(args.step === undefined ? {} : { step: args.step }),
      ...(args.connectionId === undefined ? {} : { connectionId: args.connectionId }),
      ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
      ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
      ...(data !== null && typeof data === "object" && !Array.isArray(data)
        ? { data: data as Record<string, unknown> }
        : {}),
    };
    this.#writer.enqueue(record);
  }

  /** 幂等停止并返回诊断报告。 */
  stop(): Promise<TraceShutdownReport> {
    return this.#writer.stop();
  }
}
