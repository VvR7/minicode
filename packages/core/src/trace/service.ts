import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import { TraceRecorder, type TraceRecordArgs } from "./recorder.ts";
import { nodeTraceStorage } from "./storage.ts";
import type { TraceConfig, TraceShutdownReport, TraceStorage } from "./types.ts";

/** Core 内所有 run-scoped recorder 的单点生命周期注册表。 */
export class TraceService {
  readonly #homeDirectory: string;
  readonly #config: TraceConfig;
  readonly #storage: TraceStorage;
  readonly #recorders = new Map<string, TraceRecorder>();

  constructor(
    homeDirectory: string,
    config: TraceConfig,
    storage: TraceStorage = nodeTraceStorage,
  ) {
    this.#homeDirectory = homeDirectory;
    this.#config = config;
    this.#storage = storage;
  }

  /** 为已分配身份的 run 创建并启动 recorder；任何构造失败都降级为无 Trace。 */
  startRun(sessionId: SessionId, runId: RunId): TraceRecorder | undefined {
    const key = this.#key(sessionId, runId);
    const existing = this.#recorders.get(key);
    if (existing !== undefined) return existing;
    try {
      const recorder = new TraceRecorder(
        sessionId,
        runId,
        this.#config,
        this.#storage,
        this.#homeDirectory,
      );
      recorder.start();
      this.#recorders.set(key, recorder);
      return recorder;
    } catch {
      return undefined;
    }
  }

  /** 获取一个已创建的 run recorder。 */
  recorderFor(sessionId: SessionId, runId: RunId): TraceRecorder | undefined {
    return this.#recorders.get(this.#key(sessionId, runId));
  }

  /** 在 durable event 成功持久化后记录 Core 边界。 */
  recordEvent(event: AgentEvent): void {
    this.recorderFor(event.sessionId, event.runId)?.record({
      source: "CORE",
      target: "CORE",
      kind: "core.event_persisted",
      ...("step" in event.payload && typeof event.payload.step === "number"
        ? { step: event.payload.step }
        : {}),
      data: { event: event.type, payload: event.payload },
    });
  }

  /** 向指定 run 追加一条 best-effort Trace。 */
  record(sessionId: SessionId, runId: RunId, args: TraceRecordArgs): void {
    this.recorderFor(sessionId, runId)?.record(args);
  }

  /** 停止并移除单个 run recorder。 */
  async stopRun(sessionId: SessionId, runId: RunId): Promise<TraceShutdownReport | undefined> {
    const key = this.#key(sessionId, runId);
    const recorder = this.#recorders.get(key);
    if (recorder === undefined) return undefined;
    this.#recorders.delete(key);
    return recorder.stop();
  }

  /** daemon shutdown 时并行限时停止全部 recorder。 */
  async shutdown(): Promise<void> {
    const recorders = [...this.#recorders.values()];
    this.#recorders.clear();
    await Promise.allSettled(recorders.map((recorder) => recorder.stop()));
  }

  /** 生成 session/run 复合键。 */
  #key(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }
}
