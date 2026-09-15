import type { AgentEvent, Environment, RunId, SessionEvent, SessionId } from "@minicode/protocol";
import { loadTraceConfig } from "./config.ts";
import { TraceRecorder } from "./recorder.ts";
import { nodeTraceStorage } from "./storage.ts";
import {
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_SHUTDOWN_MS_DEFAULT,
  type TraceConfig,
} from "./types.ts";

const DISABLED_TRACE_CONFIG: TraceConfig = {
  enabled: false,
  payload: "summary",
  queueEvents: TRACE_QUEUE_EVENTS_DEFAULT,
  maxBytes: TRACE_MAX_BYTES_DEFAULT,
  shutdownMs: TRACE_SHUTDOWN_MS_DEFAULT,
};

/**
 * Core 内全部 run TraceRecorder 的身份注册表。
 * 配置或写入失败只会关闭 Trace，不会改变 session/run 的业务结果。
 */
export class RunTraceRegistry {
  readonly #homeDirectory: string;
  readonly #config: TraceConfig;
  readonly #recorders = new Map<string, TraceRecorder>();

  /** 保存 Core home 并加载一次全局 Trace 配置。 */
  constructor(homeDirectory: string, environment: Environment) {
    this.#homeDirectory = homeDirectory;
    const loaded = loadTraceConfig(environment);
    this.#config = loaded.ok ? loaded.value : DISABLED_TRACE_CONFIG;
  }

  /** 为新 run 创建并启动唯一记录器；重复创建返回原实例。 */
  create(sessionId: SessionId, runId: RunId): TraceRecorder {
    const key = this.#key(sessionId, runId);
    const existing = this.#recorders.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const recorder = new TraceRecorder(
      sessionId,
      runId,
      this.#config,
      nodeTraceStorage,
      this.#homeDirectory,
    );
    recorder.start();
    this.#recorders.set(key, recorder);
    return recorder;
  }

  /** 返回指定 run 的记录器；未分配到 run 的流量没有记录器。 */
  get(sessionId: SessionId, runId: RunId): TraceRecorder | undefined {
    return this.#recorders.get(this.#key(sessionId, runId));
  }

  /** 在 AgentEvent 成功持久化后记录 Core 边界。 */
  recordAgentEvent(event: AgentEvent): void {
    this.get(event.sessionId, event.runId)?.record({
      source: "CORE",
      target: "CORE",
      kind: "core.event_persisted",
      data: { type: event.type, sequence: event.sequence, durable: event.durable },
    });
  }

  /** 在 SessionEvent 成功持久化后记录 Core 边界。 */
  recordSessionEvent(event: SessionEvent): void {
    const identity = event.payload;
    this.get(event.sessionId, identity.runId)?.record({
      source: "CORE",
      target: "CORE",
      kind: "core.event_persisted",
      data: {
        type: event.type,
        sessionSequence: event.sessionSequence,
        durable: event.durable,
      },
    });
  }

  /** 停止并移除指定 run 的记录器，等待其有界刷盘。 */
  async stop(sessionId: SessionId, runId: RunId): Promise<void> {
    const key = this.#key(sessionId, runId);
    const recorder = this.#recorders.get(key);
    this.#recorders.delete(key);
    await recorder?.stop();
  }

  /** Core shutdown 时并行停止全部仍存活的记录器。 */
  async stopAll(): Promise<void> {
    const recorders = [...this.#recorders.values()];
    this.#recorders.clear();
    await Promise.allSettled(recorders.map((recorder) => recorder.stop()));
  }

  /** 构造不会与其他 session/run 冲突的内存键。 */
  #key(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }
}
