import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SecretRedactor } from "./redactor.ts";
import type { RunState, TaskResult } from "./types.ts";

/** 原子地写入文本，避免进程中断留下半个 JSON。 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** 管理 benchmark 的 canonical 产物、历史 attempt 与 run metadata。 */
export class ArtifactStore {
  readonly root: string;
  readonly #redactor: SecretRedactor;

  /** 创建结果目录并保存统一脱敏器。 */
  constructor(root: string, redactor: SecretRedactor) {
    this.root = root;
    this.#redactor = redactor;
  }

  /** 初始化结果根目录。 */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** 返回 task 的 canonical 产物目录。 */
  taskDirectory(taskId: string): string {
    return join(this.root, taskId);
  }

  /** 读取 canonical result；不存在或无效时返回 undefined。 */
  async readResult(taskId: string): Promise<TaskResult | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.taskDirectory(taskId), "result.json"), "utf8"),
      ) as TaskResult;
    } catch {
      return undefined;
    }
  }

  /** 将旧 canonical 产物整体归档，供 force 或 cleanup_failed 重跑保留证据。 */
  async archiveExisting(taskId: string): Promise<void> {
    const directory = this.taskDirectory(taskId);
    try {
      const result = await this.readResult(taskId);
      if (result === undefined) return;
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const archive = join(directory, "attempts", stamp);
      await mkdir(archive, { recursive: true });
      for (const name of [
        "result.json",
        "patch.diff",
        "run.json",
        "events.jsonl",
        "trace.jsonl",
        "agent.stdout.log",
        "agent.stderr.log",
        "core.log",
        "evaluation.log",
      ]) {
        try {
          await rename(join(directory, name), join(archive, name));
        } catch {
          // 某类可选产物不存在时仍保留其余证据。
        }
      }
    } catch {
      // 没有旧目录时无需归档。
    }
  }

  /** 写入已经过二次脱敏的 task 文本产物。 */
  async writeTaskText(taskId: string, name: string, content: string): Promise<void> {
    await atomicWrite(
      join(this.taskDirectory(taskId), basename(name)),
      this.#redactor.redact(content),
    );
  }

  /** 写入已经过二次脱敏的 JSON 产物。 */
  async writeTaskJson(taskId: string, name: string, value: unknown): Promise<void> {
    const redacted = this.#redactor.redactValue(value);
    await atomicWrite(
      join(this.taskDirectory(taskId), basename(name)),
      `${JSON.stringify(redacted, null, 2)}\n`,
    );
  }

  /** 原子更新当前 run metadata，供 crash 恢复精确确认资源。 */
  async writeRunState(state: RunState): Promise<void> {
    await atomicWrite(
      join(this.root, "run-state.json"),
      `${JSON.stringify(this.#redactor.redactValue(state), null, 2)}\n`,
    );
  }

  /** 读取当前 run metadata。 */
  async readRunState(): Promise<RunState | undefined> {
    try {
      return JSON.parse(await readFile(join(this.root, "run-state.json"), "utf8")) as RunState;
    } catch {
      return undefined;
    }
  }

  /** 写入累计 summary。 */
  async writeSummary(value: unknown): Promise<void> {
    await atomicWrite(
      join(this.root, "summary.json"),
      `${JSON.stringify(this.#redactor.redactValue(value), null, 2)}\n`,
    );
  }

  /** 写入结果根目录中的脱敏文本报告。 */
  async writeRootText(name: string, content: string): Promise<void> {
    await atomicWrite(join(this.root, basename(name)), this.#redactor.redact(content));
  }
}
