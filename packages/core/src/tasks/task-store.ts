import { join } from "node:path";
import {
  RunIdSchema,
  SessionIdSchema,
  type RunId,
  type SessionId,
  type TaskSnapshot,
} from "@minicode/protocol";
import { nodeSessionStorage } from "../session/storage.ts";
import {
  TASK_SCHEMA_VERSION,
  TASK_TRANSITIONS,
  TaskGraphFileSchema,
  TaskRecordSchema,
  type CreateTaskInput,
  type TaskGraphFile,
  type TaskRecord,
  type TaskStorage,
  type TaskStoreFailure,
  type TaskStoreResult,
  type UpdateTaskInput,
} from "./types.ts";

type TaskMutationValue = { readonly revision: number; readonly task: TaskSnapshot };

/** 同一进程内按 tasks.json 路径共享写锁，覆盖多个 TaskManager 实例。 */
const mutationTails = new Map<string, Promise<void>>();

/** 计算某个 run 的 tasks.json 绝对路径，与 SessionStore 的路径规则一致。 */
export function tasksPath(homeDirectory: string, sessionId: SessionId, runId: RunId): string {
  return join(
    homeDirectory,
    "sessions",
    SessionIdSchema.parse(sessionId),
    "runs",
    RunIdSchema.parse(runId),
    "tasks.json",
  );
}

/** 检测直接或间接依赖环。 */
function hasCycle(tasks: readonly TaskRecord[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (id: number): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const task = byId.get(id);
    if (task !== undefined) {
      for (const dependency of task.blockedBy) {
        if (byId.has(dependency) && visit(dependency)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const task of tasks) {
    if (visit(task.id)) {
      return true;
    }
  }
  return false;
}

/** 由 blockedBy 动态推导 blocked：存在任一未 completed 依赖即为 blocked。 */
function deriveBlocked(task: TaskRecord, byId: Map<number, TaskRecord>): boolean {
  return task.blockedBy.some((dependency) => {
    const dep = byId.get(dependency);
    return dep === undefined || dep.status !== "completed";
  });
}

/** 把持久化 TaskRecord 转换为协议层 TaskSnapshot（含动态 blocked）。 */
function toSnapshot(task: TaskRecord, byId: Map<number, TaskRecord>): TaskSnapshot {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blocked: deriveBlocked(task, byId),
    blockedBy: [...task.blockedBy],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 规范化依赖：去重、升序；非法值由 schema 校验兜底。 */
function normalizeBlockedBy(dependencies: readonly number[]): number[] {
  return [...new Set(dependencies)].sort((left, right) => left - right);
}

/**
 * 单个 run 独占的 TaskManager：负责 tasks.json 的读取、校验、内存变更与原子写入。
 * 只记录和约束计划，不主动调度任务。生命周期由 run 独占保证，但写入前仍检测
 * stale revision 防止两个 manager 实例交错写同一 run。
 */
export class TaskManager {
  readonly #storage: TaskStorage;
  readonly #path: string;
  readonly #now: () => string;
  #graph: TaskGraphFile | null = null;
  #rollback: { readonly revision: number; readonly graph: TaskGraphFile } | null = null;

  /** 绑定单个 run 的存储路径，并允许测试注入确定性时钟。 */
  constructor(
    storage: TaskStorage,
    path: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#storage = storage;
    this.#path = path;
    this.#now = now;
  }

  /** 读取并校验 tasks.json；文件缺失视为空图，损坏或未知版本返回 task_store_corrupted。 */
  async load(): Promise<TaskStoreResult<TaskGraphFile>> {
    let raw: string | undefined;
    try {
      raw = await this.#storage.readFile(this.#path);
    } catch {
      return this.#fail("io_error", "failed to read tasks.json");
    }

    let graph: TaskGraphFile;
    if (raw === undefined) {
      graph = {
        schemaVersion: TASK_SCHEMA_VERSION,
        revision: 0,
        nextId: 1,
        tasks: [],
      };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return this.#fail("task_store_corrupted", "tasks.json is not valid JSON");
      }
      const result = TaskGraphFileSchema.safeParse(parsed);
      if (!result.success) {
        return this.#fail("task_store_corrupted", "tasks.json does not match the schema");
      }
      graph = result.data;
    }

    const validated = this.#validatePersisted(graph.tasks, graph.nextId);
    if (!validated.ok) {
      return validated;
    }
    this.#graph = { ...graph, tasks: [...graph.tasks].sort((a, b) => a.id - b.id) };
    return { ok: true, value: this.#graph };
  }

  /** 创建新任务；ID 取 nextId 且只增不复用。 */
  async create(
    input: CreateTaskInput,
    afterCommit?: (value: TaskMutationValue) => Promise<void>,
  ): Promise<TaskStoreResult<TaskMutationValue>> {
    return this.#withMutationLock(async () =>
      this.#finishMutation(await this.#create(input), afterCommit),
    );
  }

  /** 在 mutation lock 内执行创建并提交新图。 */
  async #create(input: CreateTaskInput): Promise<TaskStoreResult<TaskMutationValue>> {
    const loaded = await this.#ensureLoaded();
    if (!loaded.ok) {
      return loaded;
    }
    const graph = this.#graph as TaskGraphFile;
    const blockedBy = normalizeBlockedBy(input.blockedBy ?? []);

    if (blockedBy.includes(graph.nextId)) {
      return this.#fail("self_dependency", "a task cannot depend on itself");
    }
    const existingIds = new Set(graph.tasks.map((task) => task.id));
    for (const dependency of blockedBy) {
      if (!existingIds.has(dependency)) {
        return this.#fail("dependency_not_found", `dependency ${dependency} does not exist`);
      }
    }

    const timestamp = this.#now();
    const task: TaskRecord = {
      id: graph.nextId,
      subject: input.subject,
      description: input.description,
      status: "pending",
      blockedBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const parsed = TaskRecordSchema.safeParse(task);
    if (!parsed.success) {
      return this.#fail("invalid_task", "task subject or description is invalid");
    }

    const nextGraph: TaskGraphFile = {
      ...graph,
      revision: graph.revision + 1,
      nextId: graph.nextId + 1,
      tasks: [...graph.tasks, parsed.data].sort((a, b) => a.id - b.id),
    };
    const committed = await this.#commit(nextGraph);
    if (!committed.ok) {
      return committed;
    }
    return {
      ok: true,
      value: { revision: nextGraph.revision, task: this.#snapshotOf(parsed.data, nextGraph.tasks) },
    };
  }

  /** 更新任务；校验状态转换、blocked 约束、依赖引用与环，completed 不可变。 */
  async update(
    input: UpdateTaskInput,
    afterCommit?: (value: TaskMutationValue) => Promise<void>,
  ): Promise<TaskStoreResult<TaskMutationValue>> {
    return this.#withMutationLock(async () =>
      this.#finishMutation(await this.#update(input), afterCommit),
    );
  }

  /** 在 mutation lock 内执行更新、整图校验与提交。 */
  async #update(input: UpdateTaskInput): Promise<TaskStoreResult<TaskMutationValue>> {
    const loaded = await this.#ensureLoaded();
    if (!loaded.ok) {
      return loaded;
    }
    const graph = this.#graph as TaskGraphFile;
    const index = graph.tasks.findIndex((task) => task.id === input.id);
    if (index < 0) {
      return this.#fail("task_not_found", `task ${input.id} does not exist`);
    }
    const current = graph.tasks[index] as TaskRecord;

    const hasChange =
      input.subject !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.blockedBy !== undefined;
    if (!hasChange) {
      return this.#fail("invalid_task", "at least one change field is required");
    }
    if (current.status === "completed") {
      return this.#fail("immutable_task", "a completed task cannot be modified");
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (!TASK_TRANSITIONS[current.status].includes(input.status)) {
        return this.#fail(
          "invalid_transition",
          `cannot transition from ${current.status} to ${input.status}`,
        );
      }
    }

    const candidate: TaskRecord = {
      ...current,
      subject: input.subject ?? current.subject,
      description: input.description ?? current.description,
      status: input.status ?? current.status,
      blockedBy:
        input.blockedBy === undefined ? current.blockedBy : normalizeBlockedBy(input.blockedBy),
      updatedAt: this.#now(),
    };
    const parsed = TaskRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      return this.#fail("invalid_task", "updated task fields are invalid");
    }

    if (parsed.data.blockedBy.includes(parsed.data.id)) {
      return this.#fail("self_dependency", "a task cannot depend on itself");
    }
    const existingIds = new Set(graph.tasks.map((task) => task.id));
    for (const dependency of parsed.data.blockedBy) {
      if (!existingIds.has(dependency)) {
        return this.#fail("dependency_not_found", `dependency ${dependency} does not exist`);
      }
    }

    const candidateTasks = [...graph.tasks];
    candidateTasks[index] = parsed.data;
    if (hasCycle(candidateTasks)) {
      return this.#fail("cycle_dependency", "dependency graph contains a cycle");
    }

    if (parsed.data.status !== "pending") {
      const byId = new Map(candidateTasks.map((task) => [task.id, task]));
      if (deriveBlocked(parsed.data, byId)) {
        return this.#fail("blocked_task", "a blocked task cannot be in_progress or completed");
      }
    }

    const nextGraph: TaskGraphFile = {
      ...graph,
      revision: graph.revision + 1,
      tasks: candidateTasks.sort((a, b) => a.id - b.id),
    };
    const committed = await this.#commit(nextGraph);
    if (!committed.ok) {
      return committed;
    }
    return {
      ok: true,
      value: { revision: nextGraph.revision, task: this.#snapshotOf(parsed.data, nextGraph.tasks) },
    };
  }

  /** 列出任务（可选按 status 过滤），按 ID 升序返回。 */
  async list(
    status?: TaskRecord["status"],
  ): Promise<TaskStoreResult<{ revision: number; tasks: TaskSnapshot[] }>> {
    const loaded = await this.#ensureLoaded();
    if (!loaded.ok) {
      return loaded;
    }
    const graph = this.#graph as TaskGraphFile;
    const byId = new Map(graph.tasks.map((task) => [task.id, task]));
    const tasks = graph.tasks
      .filter((task) => status === undefined || task.status === status)
      .map((task) => toSnapshot(task, byId));
    return { ok: true, value: { revision: graph.revision, tasks } };
  }

  /** 读取单个任务。 */
  async get(id: number): Promise<TaskStoreResult<{ revision: number; task: TaskSnapshot }>> {
    const loaded = await this.#ensureLoaded();
    if (!loaded.ok) {
      return loaded;
    }
    const graph = this.#graph as TaskGraphFile;
    const task = graph.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
      return this.#fail("task_not_found", `task ${id} does not exist`);
    }
    return {
      ok: true,
      value: { revision: graph.revision, task: this.#snapshotOf(task, graph.tasks) },
    };
  }

  /** 在共享写锁内执行提交后回调；失败时先补偿任务图再返回稳定错误。 */
  async #finishMutation(
    result: TaskStoreResult<TaskMutationValue>,
    afterCommit: ((value: TaskMutationValue) => Promise<void>) | undefined,
  ): Promise<TaskStoreResult<TaskMutationValue>> {
    if (!result.ok) {
      return result;
    }
    if (afterCommit === undefined) {
      this.#rollback = null;
      return result;
    }
    try {
      await afterCommit(result.value);
      this.#rollback = null;
      return result;
    } catch {
      const rolledBack = await this.#rollbackMutation(result.value.revision);
      return this.#fail(
        "io_error",
        rolledBack.ok
          ? "failed to persist task event"
          : "failed to persist task event and roll back task state",
      );
    }
  }

  /** durable event 失败时恢复上一图；调用方必须已持有共享写锁。 */
  async #rollbackMutation(revision: number): Promise<TaskStoreResult<void>> {
    const rollback = this.#rollback;
    if (rollback === null || rollback.revision !== revision || this.#graph?.revision !== revision) {
      return this.#fail("stale_revision", "task mutation can no longer be rolled back");
    }
    const disk = await this.#readDiskGraph();
    if (!disk.ok) {
      return disk;
    }
    if (disk.value === undefined || !this.#sameGraph(disk.value, this.#graph)) {
      return this.#fail("stale_revision", "tasks.json changed before rollback");
    }
    try {
      await this.#storage.writeFileAtomic(
        this.#path,
        `${JSON.stringify(rollback.graph, null, 2)}\n`,
      );
    } catch {
      return this.#fail("io_error", "failed to roll back tasks.json");
    }
    this.#graph = rollback.graph;
    this.#rollback = null;
    return { ok: true, value: undefined };
  }

  /** 懒加载图，保证 create/update/list/get 首次调用前已校验落盘状态。 */
  async #ensureLoaded(): Promise<TaskStoreResult<void>> {
    if (this.#graph !== null) {
      return { ok: true, value: undefined };
    }
    const loaded = await this.load();
    if (!loaded.ok) {
      return loaded;
    }
    return { ok: true, value: undefined };
  }

  /** 校验已持久化的整图：任何结构违例都收敛为 task_store_corrupted。 */
  #validatePersisted(tasks: readonly TaskRecord[], nextId: number): TaskStoreResult<void> {
    const ids = new Set<number>();
    for (const [index, task] of tasks.entries()) {
      if (ids.has(task.id)) {
        return this.#fail("task_store_corrupted", "duplicate task id");
      }
      if (index > 0 && (tasks[index - 1]?.id ?? 0) >= task.id) {
        return this.#fail("task_store_corrupted", "tasks are not ordered by id");
      }
      if (
        task.blockedBy.some(
          (dependency, dependencyIndex) =>
            dependencyIndex > 0 &&
            (task.blockedBy[dependencyIndex - 1] ?? dependency) >= dependency,
        )
      ) {
        return this.#fail("task_store_corrupted", "task dependencies are not unique and ordered");
      }
      ids.add(task.id);
    }
    for (const task of tasks) {
      for (const dependency of task.blockedBy) {
        if (dependency === task.id || !ids.has(dependency)) {
          return this.#fail("task_store_corrupted", "task has an invalid dependency");
        }
      }
    }
    if (hasCycle(tasks)) {
      return this.#fail("task_store_corrupted", "dependency graph contains a cycle");
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (tasks.some((task) => task.status !== "pending" && deriveBlocked(task, byId))) {
      return this.#fail("task_store_corrupted", "a started or completed task is blocked");
    }
    const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
    if (nextId <= maxId) {
      return this.#fail("task_store_corrupted", "nextId must exceed every task id");
    }
    return { ok: true, value: undefined };
  }

  /** 原子提交：先做 stale revision 检测，写失败绝不推进内存状态。 */
  async #commit(nextGraph: TaskGraphFile): Promise<TaskStoreResult<void>> {
    if (!TaskGraphFileSchema.safeParse(nextGraph).success) {
      return this.#fail("invalid_task", "task graph limit reached");
    }
    const disk = await this.#readDiskGraph();
    if (!disk.ok) {
      return disk;
    }
    const current = this.#graph as TaskGraphFile;
    const diskMatchesInitialEmpty =
      disk.value === undefined &&
      current.revision === 0 &&
      current.nextId === 1 &&
      current.tasks.length === 0;
    if (
      !diskMatchesInitialEmpty &&
      (disk.value === undefined || !this.#sameGraph(disk.value, current))
    ) {
      return this.#fail("stale_revision", "tasks.json was modified by another manager");
    }
    try {
      await this.#storage.writeFileAtomic(this.#path, `${JSON.stringify(nextGraph, null, 2)}\n`);
    } catch {
      return this.#fail("io_error", "failed to write tasks.json");
    }
    this.#rollback = { revision: nextGraph.revision, graph: current };
    this.#graph = nextGraph;
    return { ok: true, value: undefined };
  }

  /** 读取并完整校验磁盘图；文件缺失返回 undefined。 */
  async #readDiskGraph(): Promise<TaskStoreResult<TaskGraphFile | undefined>> {
    let raw: string | undefined;
    try {
      raw = await this.#storage.readFile(this.#path);
    } catch {
      return this.#fail("io_error", "failed to read tasks.json during commit");
    }
    if (raw === undefined) {
      return { ok: true, value: undefined };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return this.#fail("task_store_corrupted", "tasks.json became corrupt");
    }
    const result = TaskGraphFileSchema.safeParse(parsed);
    if (!result.success) {
      return this.#fail("task_store_corrupted", "tasks.json schema became invalid");
    }
    const validated = this.#validatePersisted(result.data.tasks, result.data.nextId);
    if (!validated.ok) {
      return validated;
    }
    return { ok: true, value: result.data };
  }

  /** 比较两个规范化任务图，检测 revision 未变但内容被外部替换的情况。 */
  #sameGraph(left: TaskGraphFile, right: TaskGraphFile): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** 按文件路径串行化所有 manager 的变更与提交后回调，避免交错覆盖。 */
  async #withMutationLock<Value>(
    operation: () => Promise<TaskStoreResult<Value>>,
  ): Promise<TaskStoreResult<Value>> {
    const previous = mutationTails.get(this.#path) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutationTails.set(this.#path, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutationTails.get(this.#path) === current) {
        mutationTails.delete(this.#path);
      }
    }
  }

  /** 由已落盘的任务数组构建单个任务的快照。 */
  #snapshotOf(task: TaskRecord, tasks: readonly TaskRecord[]): TaskSnapshot {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    return toSnapshot(task, byId);
  }

  /** 构造稳定且不包含底层异常细节的领域失败结果。 */
  #fail(code: TaskStoreFailure["code"], message: string): TaskStoreResult<never> {
    return { ok: false, error: { code, message } };
  }
}

/** 默认的真实文件存储：复用 session 的原子写入 + fsync 实现。 */
export const nodeTaskStorage: TaskStorage = nodeSessionStorage;
