import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import { TraceRecorder, type TraceRecordArgs } from "./recorder.ts";
import { nodeTraceStorage } from "./storage.ts";
import type { TraceConfig, TraceShutdownReport, TraceStorage } from "./types.ts";

interface TraceEntry {
  readonly recorder: TraceRecorder;
  runFinished: boolean;
  responseFinished: boolean;
}

/** Trace 异常关闭诊断，供 Core logger 安全输出计数。 */
export interface TraceDiagnostic {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly report: TraceShutdownReport;
}

/** Core 内所有 run-scoped recorder 的单点生命周期注册表。 */
export class TraceService {
  readonly #homeDirectory: string;
  readonly #config: TraceConfig;
  readonly #storage: TraceStorage;
  readonly #recorders = new Map<string, TraceEntry>();
  readonly #onDiagnostic: ((diagnostic: TraceDiagnostic) => void) | undefined;

  /** 保存 Core home、Trace 配置、存储实现与安全诊断出口。 */
  constructor(
    homeDirectory: string,
    config: TraceConfig,
    storage: TraceStorage = nodeTraceStorage,
    onDiagnostic?: (diagnostic: TraceDiagnostic) => void,
  ) {
    this.#homeDirectory = homeDirectory;
    this.#config = config;
    this.#storage = storage;
    this.#onDiagnostic = onDiagnostic;
  }

  /** 为已分配身份的 run 创建 recorder；可等待初始 RPC response 后再关闭。 */
  startRun(sessionId: SessionId, runId: RunId, waitForResponse = false): TraceRecorder | undefined {
    const key = this.#key(sessionId, runId);
    const existing = this.#recorders.get(key);
    if (existing !== undefined) return existing.recorder;
    try {
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
        responseFinished: !waitForResponse,
      });
      return recorder;
    } catch {
      return undefined;
    }
  }

  /** 获取一个已创建的 run recorder。 */
  recorderFor(sessionId: SessionId, runId: RunId): TraceRecorder | undefined {
    return this.#recorders.get(this.#key(sessionId, runId))?.recorder;
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

  /** 标记 run 执行完成；response 也完成后才停止 recorder。 */
  async finishRun(sessionId: SessionId, runId: RunId): Promise<TraceShutdownReport | undefined> {
    const entry = this.#recorders.get(this.#key(sessionId, runId));
    if (entry === undefined) return undefined;
    entry.runFinished = true;
    return this.#finishIfReady(sessionId, runId, entry);
  }

  /** 标记初始 RPC response 已发送或失败，保护慢客户端的 sent/error 记录。 */
  async finishResponse(
    sessionId: SessionId,
    runId: RunId,
  ): Promise<TraceShutdownReport | undefined> {
    const entry = this.#recorders.get(this.#key(sessionId, runId));
    if (entry === undefined) return undefined;
    entry.responseFinished = true;
    return this.#finishIfReady(sessionId, runId, entry);
  }

  /** 失败回滚或 shutdown 时无条件停止并移除单个 recorder。 */
  async stopRun(sessionId: SessionId, runId: RunId): Promise<TraceShutdownReport | undefined> {
    const key = this.#key(sessionId, runId);
    const entry = this.#recorders.get(key);
    if (entry === undefined) return undefined;
    this.#recorders.delete(key);
    const report = await entry.recorder.stop();
    this.#reportDiagnostic(sessionId, runId, report);
    return report;
  }

  /** daemon shutdown 时并行限时停止全部 recorder，并返回各 run 报告。 */
  async shutdown(): Promise<readonly TraceDiagnostic[]> {
    const identities = [...this.#recorders.keys()].map((key) => key.split(":")) as [
      SessionId,
      RunId,
    ][];
    return Promise.all(
      identities.map(async ([sessionId, runId]) => ({
        sessionId,
        runId,
        report: (await this.stopRun(sessionId, runId)) as TraceShutdownReport,
      })),
    );
  }

  /** 双门闩均完成后停止 recorder。 */
  async #finishIfReady(
    sessionId: SessionId,
    runId: RunId,
    entry: TraceEntry,
  ): Promise<TraceShutdownReport | undefined> {
    if (!entry.runFinished || !entry.responseFinished) return undefined;
    return this.stopRun(sessionId, runId);
  }

  /** 仅将异常报告交给诊断出口，正常关闭不制造日志噪声。 */
  #reportDiagnostic(sessionId: SessionId, runId: RunId, report: TraceShutdownReport): void {
    if (
      report.pendingRecords === 0 &&
      report.droppedRecords === 0 &&
      !report.timedOut &&
      !report.writeFailed
    ) {
      return;
    }
    try {
      this.#onDiagnostic?.({ sessionId, runId, report });
    } catch {
      // 诊断出口本身也是 observer，失败不得影响 daemon。
    }
  }

  /** 生成 session/run 复合键。 */
  #key(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }
}
