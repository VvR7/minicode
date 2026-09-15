import type { RunId } from "@minicode/protocol";
import type { TraceStorage, TraceStorageHandle } from "../../src/trace/types.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待可控 gate，并在 shutdown abort 时立即退出。 */
async function waitForGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  await Promise.race([
    gate,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/** 可注入故障/门控/延迟的内存 Trace 存储，用于确定性地覆盖 writer 边界分支。 */
export class MemoryTraceStorage implements TraceStorage {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  /** 阻塞 openAppend 的 Promise，用于在打开文件前冻结 worker。 */
  openGate: Promise<void> | null = null;
  /** 阻塞每次 write 的 Promise。 */
  writeGate: Promise<void> | null = null;
  /** 每次 write 的固定延迟。 */
  writeDelayMs = 0;
  openError: Error | null = null;
  writeError: Error | null = null;

  async ensureDirectory(path: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.directories.add(path);
  }

  async readFile(path: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    return this.files.get(path);
  }

  async openAppend(path: string, signal: AbortSignal): Promise<TraceStorageHandle> {
    if (this.openGate !== null) {
      await waitForGate(this.openGate, signal);
    }
    if (this.openError !== null) {
      throw this.openError;
    }
    const storage = this;
    return {
      async write(text, writeSignal) {
        if (storage.writeGate !== null) {
          await waitForGate(storage.writeGate, writeSignal);
        }
        if (storage.writeDelayMs > 0) {
          await sleep(storage.writeDelayMs);
        }
        if (storage.writeError !== null) {
          throw storage.writeError;
        }
        storage.files.set(path, `${storage.files.get(path) ?? ""}${text}`);
      },
      async close() {},
    };
  }

  /** 读取某个 trace 文件已写入的非空行。 */
  lines(path: string): string[] {
    const content = this.files.get(path) ?? "";
    return content.split("\n").filter((line) => line.length > 0);
  }
}

/** 构造一条不含 sequence 的 TraceRecordInput，供 writer/recorder 测试复用。 */
export function makeTraceRecord(
  index: number,
  data: Record<string, unknown> = {},
  runId: RunId = RUN_A,
): {
  schemaVersion: 1;
  observedAt: string;
  source: "CORE";
  target: "CORE";
  kind: "ipc.error";
  sessionId: typeof SESSION_A;
  runId: RunId;
  data: Record<string, unknown>;
} {
  return {
    schemaVersion: 1,
    observedAt: "2026-09-14T08:00:00.000Z",
    source: "CORE",
    target: "CORE",
    kind: "ipc.error",
    sessionId: SESSION_A,
    runId,
    data: { index, ...data },
  };
}
