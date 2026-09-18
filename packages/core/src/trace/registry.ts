import type { AgentEvent, Environment, RunId, SessionEvent, SessionId } from "@minicode/protocol";
import { loadTraceConfig } from "./config.ts";
import { TraceRecorder } from "./recorder.ts";
import { nodeTraceStorage } from "./storage.ts";
import {
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_SHUTDOWN_MS_DEFAULT,
  type TraceConfig,
  type TraceShutdownReport,
  type TraceStorage,
} from "./types.ts";

const DISABLED_TRACE_CONFIG: TraceConfig = {
  enabled: false,
  payload: "summary",
  queueEvents: TRACE_QUEUE_EVENTS_DEFAULT,
  maxBytes: TRACE_MAX_BYTES_DEFAULT,
  shutdownMs: TRACE_SHUTDOWN_MS_DEFAULT,
};

interface RunTraceEntry {
  readonly recorder: TraceRecorder;
  runFinished: boolean;
  responseFinished: boolean;
}

/**
 * Core 内全部 run TraceRecorder 的身份注册表。
 * 配置或写入失败只会关闭 Trace，不会改变 session/run 的业务结果。
 */
export class RunTraceRegistry {
  readonly #homeDirectory: string;
  readonly #config: TraceConfig;
  readonly #storage: TraceStorage;
  readonly #recorders = new Map<string, RunTraceEntry>();

  /** 保存 Core home 并加载一次全局 Trace 配置。 */
  constructor(
    homeDirectory: string,
    environment: Environment,
    storage: TraceStorage = nodeTraceStorage,
  ) {
    this.#homeDirectory = homeDirectory;
    const loaded = loadTraceConfig(environment);
    this.#config = loaded.ok ? loaded.value : DISABLED_TRACE_CONFIG;
    this.#storage = storage;
  }

  /** 为新 run 创建并启动唯一记录器；重复创建返回原实例。 */
  create(sessionId: SessionId, runId: RunId): TraceRecorder {
    const key = this.#key(sessionId, runId);
    const existing = this.#recorders.get(key);
    if (existing !== undefined) {
      return existing.recorder;
    }
    const recorder = new TraceRecorder(
      sessionId,
      runId,
      this.#config,
      this.#storage,
      this.#homeDirectory,
    );
    recorder.start();
    this.#recorders.set(key, {
      recorder,
      runFinished: false,
      responseFinished: false,
    });
    return recorder;
  }

  /** 返回指定 run 的记录器；未分配到 run 的流量没有记录器。 */
  get(sessionId: SessionId, runId: RunId): TraceRecorder | undefined {
    return this.#recorders.get(this.#key(sessionId, runId))?.recorder;
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
    if (!("runId" in event.payload)) return;
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

  /** 标记 run 终态已经提交；初始 RPC response 也完成后才停止记录器。 */
  async finishRun(sessionId: SessionId, runId: RunId): Promise<TraceShutdownReport | undefined> {
    const entry = this.#recorders.get(this.#key(sessionId, runId));
    if (entry === undefined) return undefined;
    entry.runFinished = true;
    return this.#finishIfReady(sessionId, runId, entry);
  }

  /** 标记初始 RPC response 已发送或失败；run 也完成后才停止记录器。 */
  async finishResponse(
    sessionId: SessionId,
    runId: RunId,
  ): Promise<TraceShutdownReport | undefined> {
    const entry = this.#recorders.get(this.#key(sessionId, runId));
    if (entry === undefined) return undefined;
    entry.responseFinished = true;
    return this.#finishIfReady(sessionId, runId, entry);
  }

  /** 无条件停止并移除指定 run 的记录器，供 shutdown 收尾使用。 */
  async stop(sessionId: SessionId, runId: RunId): Promise<TraceShutdownReport | undefined> {
    const key = this.#key(sessionId, runId);
    const entry = this.#recorders.get(key);
    if (entry === undefined) return undefined;
    this.#recorders.delete(key);
    return entry.recorder.stop();
  }

  /** Core shutdown 时并行停止全部仍存活的记录器。 */
  async stopAll(): Promise<void> {
    const recorders = [...this.#recorders.values()].map((entry) => entry.recorder);
    this.#recorders.clear();
    await Promise.allSettled(recorders.map((recorder) => recorder.stop()));
  }

  /** 双门闩均完成时原子移除并停止记录器。 */
  #finishIfReady(
    sessionId: SessionId,
    runId: RunId,
    entry: RunTraceEntry,
  ): Promise<TraceShutdownReport | undefined> {
    if (!entry.runFinished || !entry.responseFinished) {
      return Promise.resolve(undefined);
    }
    return this.stop(sessionId, runId);
  }

  /** 构造不会与其他 session/run 冲突的内存键。 */
  #key(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }
}
