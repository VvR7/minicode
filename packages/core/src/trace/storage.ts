import { chmod, mkdir, open, readFile } from "node:fs/promises";
import type { TraceStorage, TraceStorageHandle } from "./types.ts";

/**
 * 基于 node:fs/promises 的真实 Trace 存储实现。
 * 目录 0700、文件 0600；写失败抛给 writer，由 writer 收敛为 best-effort。
 */
export const nodeTraceStorage: TraceStorage = {
  async ensureDirectory(path, signal) {
    signal.throwIfAborted();
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    signal.throwIfAborted();
  },
  async readFile(path, signal) {
    try {
      return await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  },
  async openAppend(path, signal): Promise<TraceStorageHandle> {
    signal.throwIfAborted();
    const handle = await open(path, "a", 0o600);
    try {
      signal.throwIfAborted();
      await handle.chmod(0o600);
      signal.throwIfAborted();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return {
      async write(text, writeSignal) {
        await handle.writeFile(text, { encoding: "utf8", signal: writeSignal });
      },
      async close() {
        await handle.close();
      },
    };
  },
};
