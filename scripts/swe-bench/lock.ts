import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 使用原子目录创建实现跨进程 benchmark 锁。 */
export class BenchmarkLock {
  readonly #directory: string;
  #held = false;

  /** 在结果根目录下选择独立 lock 目录。 */
  constructor(resultsDirectory: string) {
    this.#directory = join(resultsDirectory, ".runner.lock");
  }

  /** 获取全局锁；已有锁时报告持有者并拒绝并发运行。 */
  async acquire(): Promise<void> {
    await mkdir(dirname(this.#directory), { recursive: true });
    try {
      await mkdir(this.#directory);
      await writeFile(
        join(this.#directory, "owner.json"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      this.#held = true;
    } catch {
      let owner = "unknown";
      try {
        owner = await readFile(join(this.#directory, "owner.json"), "utf8");
      } catch {
        // 保留 unknown，避免误判并删除另一进程的锁。
      }
      throw new Error(`another SWE-bench runner or stale lock exists: ${owner.trim()}`);
    }
  }

  /** 判断 lock owner PID 是否仍存活，防止 cleanup-stale 打断真实 runner。 */
  async heldByLiveProcess(): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(join(this.#directory, "owner.json"), "utf8")) as {
        readonly pid?: number;
      };
      if (!Number.isInteger(owner.pid)) return false;
      process.kill(owner.pid as number, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }

  /** 仅释放本进程已成功获取的锁。 */
  async release(): Promise<void> {
    if (!this.#held) return;
    await rm(this.#directory, { recursive: true });
    this.#held = false;
  }

  /** 显式 stale cleanup 成功后移除遗留锁目录。 */
  async removeStale(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }
}
