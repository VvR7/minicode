import { chmod, mkdir, open, readFile } from "node:fs/promises";
import type { TraceStorage, TraceStorageHandle } from "./types.ts";

/**
 * 基于 node:fs/promises 的真实 Trace 存储实现。
 * 目录 0700、文件 0600；写失败抛给 writer，由 writer 收敛为 best-effort。
 */
export const nodeTraceStorage: TraceStorage = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  },
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
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
  async openAppend(path): Promise<TraceStorageHandle> {
    const handle = await open(path, "a", 0o600);
    await handle.chmod(0o600);
    return {
      async write(text) {
        await handle.writeFile(text, { encoding: "utf8" });
      },
      async close() {
        await handle.close();
      },
    };
  },
};
