import { TaskManager } from "../../src/tasks/task-store.ts";
import type { TaskStorage } from "../../src/tasks/types.ts";

/** 可注入故障的内存任务存储，覆盖损坏与 I/O 分支。 */
export class MemoryTaskStorage implements TaskStorage {
  readonly files = new Map<string, string>();
  readError: Error | undefined;
  writeError: Error | undefined;

  async readFile(path: string): Promise<string | undefined> {
    if (this.readError !== undefined) {
      throw this.readError;
    }
    return this.files.get(path);
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    this.files.set(path, content);
  }
}

/** 构造带确定性时钟的 TaskManager 与内存存储。 */
export function createTaskManager(path = "/home/sessions/a/runs/b/tasks.json"): {
  manager: TaskManager;
  storage: MemoryTaskStorage;
  tick: () => string;
} {
  const storage = new MemoryTaskStorage();
  let counter = 0;
  const tick = (): string => {
    counter += 1;
    return new Date(Date.UTC(2026, 8, 14, 9, 0, counter)).toISOString();
  };
  return { manager: new TaskManager(storage, path, tick), storage, tick };
}
