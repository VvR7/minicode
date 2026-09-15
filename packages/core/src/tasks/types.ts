import { TaskStatusSchema } from "@minicode/protocol";
import { z } from "zod";

/** tasks.json 磁盘格式版本；未知版本一律视为 task_store_corrupted。 */
export const TASK_SCHEMA_VERSION = 1 as const;

/**
 * 持久化的任务记录。blocked 不落盘，读取时由 blockedBy 中是否存在
 * 未 completed 的依赖动态推导。
 */
export const TaskRecordSchema = z.strictObject({
  id: z.number().int().positive(),
  subject: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  status: TaskStatusSchema,
  blockedBy: z.array(z.number().int().positive()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/** tasks.json 的文件结构：revision 每次成功变更 +1，nextId 只增不复用。 */
export const TaskGraphFileSchema = z.strictObject({
  schemaVersion: z.literal(TASK_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  nextId: z.number().int().positive(),
  tasks: z.array(TaskRecordSchema),
});
export type TaskGraphFile = z.infer<typeof TaskGraphFileSchema>;

/** TaskManager 的最小 I/O 契约：只读 + 同目录临时文件原子的覆盖替换。 */
export interface TaskStorage {
  readFile(path: string): Promise<string | undefined>;
  writeFileAtomic(path: string, content: string): Promise<void>;
}

/** 创建任务的输入。 */
export interface CreateTaskInput {
  readonly subject: string;
  readonly description: string;
  readonly blockedBy?: readonly number[];
}

/** 更新任务的输入；至少提供一个变更字段。 */
export interface UpdateTaskInput {
  readonly id: number;
  readonly subject?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly blockedBy?: readonly number[];
}

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 任务存储的稳定错误码。 */
export type TaskStoreFailureCode =
  | "task_store_corrupted"
  | "io_error"
  | "invalid_task"
  | "task_not_found"
  | "invalid_transition"
  | "blocked_task"
  | "self_dependency"
  | "dependency_not_found"
  | "cycle_dependency"
  | "immutable_task"
  | "stale_revision";

export interface TaskStoreFailure {
  readonly code: TaskStoreFailureCode;
  readonly message: string;
}

export type TaskStoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: TaskStoreFailure };

/** 合法状态转换表；completed 为终态。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: [],
};
