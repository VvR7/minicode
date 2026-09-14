import { dirname, join } from "node:path";
import type { RunId, SessionId } from "@minicode/protocol";
import {
  TRACE_RECORD_MAX_BYTES,
  TRACE_SCHEMA_VERSION,
  TRACE_TRUNCATED_RESERVE_BYTES,
  type TraceConfig,
  type TraceRecord,
  type TraceRecordInput,
  type TraceShutdownReport,
  type TraceStorage,
  type TraceStorageHandle,
} from "./types.ts";

const encoder = new TextEncoder();

/**
 * 单个 run 的 Trace 写入器：单消费者有界队列 + 后台 worker。
 * 负责 sequence 分配、文件上限、queue 溢出 drop 计数、trace.truncated 记录
 * 以及限时 shutdown。任何失败都被收敛为诊断报告，绝不抛给 run。
 */
export class TraceWriter {
  readonly #sessionId: SessionId;
  readonly #runId: RunId;
  readonly #path: string;
  readonly #config: TraceConfig;
  readonly #storage: TraceStorage;
  readonly #queue: TraceRecordInput[] = [];

  #handle: TraceStorageHandle | null = null;
  #nextSequence = 1;
  #bytesWritten = 0;
  #recordsWritten = 0;
  #droppedRecords = 0;
  #droppedBytes = 0;
  #sizeLimitReached = false;
  #running = false;
  #stopped = false;
  #timedOut = false;
  #writeFailed = false;
  #stopDeadline = 0;
  #wakeResolve: (() => void) | null = null;
  #workerPromise: Promise<void> | null = null;
  #report: TraceShutdownReport | null = null;

  constructor(
    sessionId: SessionId,
    runId: RunId,
    config: TraceConfig,
    storage: TraceStorage,
    directory: string,
  ) {
    this.#sessionId = sessionId;
    this.#runId = runId;
    this.#config = config;
    this.#storage = storage;
    this.#path = join(directory, "trace.jsonl");
  }

  /** 幂等启动 worker；已经运行或已停止时不做任何事。 */
  start(): void {
    if (this.#running || this.#stopped) {
      return;
    }
    this.#running = true;
    this.#workerPromise = this.#runWorker();
  }

  /** 入队一条记录；队列满或不可写时按 drop 计数，绝不阻塞调用方。 */
  enqueue(record: TraceRecordInput): void {
    if (!this.#running || this.#stopped || this.#sizeLimitReached) {
      this.#drop(this.#estimateBytes(record));
      return;
    }
    if (this.#queue.length >= this.#config.queueEvents) {
      this.#drop(this.#estimateBytes(record));
      return;
    }
    this.#queue.push(record);
    this.#wake();
  }

  /** 幂等停止：只等待配置时限，超时后报告未刷盘计数并结束。 */
  stop(): Promise<TraceShutdownReport> {
    if (this.#report !== null) {
      return Promise.resolve(this.#report);
    }
    if (!this.#running) {
      this.#report = this.#buildReport();
      return Promise.resolve(this.#report);
    }
    this.#stopped = true;
    this.#stopDeadline = Date.now() + this.#config.shutdownMs;
    this.#wake();
    const worker = this.#workerPromise ?? Promise.resolve();
    return worker.then(() => {
      if (this.#report === null) {
        this.#report = this.#buildReport();
      }
      return this.#report;
    });
  }

  /** 后台 worker：打开文件后循环刷盘，直到停止且队列清空或超时。 */
  async #runWorker(): Promise<void> {
    try {
      await this.#storage.ensureDirectory(dirname(this.#path));
      this.#handle = await this.#storage.openAppend(this.#path);
    } catch {
      // 打开失败：Trace 是 best-effort observer，静默停止。
      this.#writeFailed = true;
      this.#stopped = true;
      return;
    }
    while (true) {
      if (this.#queue.length === 0) {
        if (this.#stopped) {
          break;
        }
        await this.#waitForWake();
        continue;
      }
      if (this.#stopped && Date.now() >= this.#stopDeadline) {
        this.#timedOut = true;
        break;
      }
      const record = this.#queue.shift() as TraceRecordInput;
      await this.#writeRecord(record);
      if (this.#writeFailed) {
        break;
      }
    }
    await this.#handle.close().catch(() => {});
  }

  /** 写入单条记录；处理溢出 drop 计数、record 上限与文件上限。 */
  async #writeRecord(record: TraceRecordInput): Promise<void> {
    // 下一个可写机会先附带累计的 drop 计数。
    if (this.#droppedRecords > 0) {
      await this.#writeTruncated("queue_overflow");
    }

    const stamped: TraceRecord = { ...record, sequence: this.#nextSequence };
    let line: string;
    try {
      line = `${JSON.stringify(stamped)}\n`;
    } catch {
      this.#drop(0);
      return;
    }
    let lineBytes = encoder.encode(line).byteLength;
    // 单 record 上限：剥离 data 用占位替换后重试。
    if (lineBytes > TRACE_RECORD_MAX_BYTES) {
      stamped.data = { truncated: true, reason: "record_size_limit" };
      line = `${JSON.stringify(stamped)}\n`;
      lineBytes = encoder.encode(line).byteLength;
    }

    // 文件上限：为 trace.truncated 预留空间，达到后停止写普通记录。
    if (this.#bytesWritten + lineBytes + TRACE_TRUNCATED_RESERVE_BYTES > this.#config.maxBytes) {
      this.#drop(lineBytes);
      await this.#writeTruncated("size_limit");
      this.#sizeLimitReached = true;
      return;
    }

    try {
      await this.#handle?.write(line);
      this.#bytesWritten += lineBytes;
      this.#recordsWritten += 1;
      this.#nextSequence += 1;
    } catch {
      this.#writeFailed = true;
      this.#stopped = true;
    }
  }

  /** 写入一条 trace.truncated 诊断记录；空间不足时计数留在报告中。 */
  async #writeTruncated(reason: "queue_overflow" | "size_limit"): Promise<void> {
    const record: TraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      sequence: this.#nextSequence,
      observedAt: new Date().toISOString(),
      source: "CORE",
      target: "CORE",
      kind: "trace.truncated",
      sessionId: this.#sessionId,
      runId: this.#runId,
      data: {
        reason,
        droppedRecords: this.#droppedRecords,
        droppedBytes: this.#droppedBytes,
      },
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = encoder.encode(line).byteLength;
    if (this.#bytesWritten + lineBytes > this.#config.maxBytes) {
      return;
    }
    try {
      await this.#handle?.write(line);
      this.#bytesWritten += lineBytes;
      this.#recordsWritten += 1;
      this.#nextSequence += 1;
      this.#droppedRecords = 0;
      this.#droppedBytes = 0;
    } catch {
      this.#writeFailed = true;
      this.#stopped = true;
    }
  }

  /** 记录一次 drop；bytes 由调用方给出或估算。 */
  #drop(bytes: number): void {
    this.#droppedRecords += 1;
    this.#droppedBytes += bytes;
  }

  /** 估算记录序列化后的字节数；失败返回 0。 */
  #estimateBytes(record: TraceRecordInput): number {
    try {
      return encoder.encode(JSON.stringify(record)).byteLength;
    } catch {
      return 0;
    }
  }

  /** 唤醒 worker。 */
  #wake(): void {
    const resolve = this.#wakeResolve;
    this.#wakeResolve = null;
    resolve?.();
  }

  /** 等待下一次入队或停止信号；入队/停止与检查之间的竞态会二次检查队列。 */
  async #waitForWake(): Promise<void> {
    if (this.#queue.length > 0 || this.#stopped) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#wakeResolve = resolve;
    });
    this.#wakeResolve = null;
  }

  /** 组装 shutdown 诊断报告。 */
  #buildReport(): TraceShutdownReport {
    return {
      bytesWritten: this.#bytesWritten,
      recordsWritten: this.#recordsWritten,
      pendingRecords: this.#queue.length,
      droppedRecords: this.#droppedRecords,
      droppedBytes: this.#droppedBytes,
      timedOut: this.#timedOut,
      writeFailed: this.#writeFailed,
    };
  }
}
