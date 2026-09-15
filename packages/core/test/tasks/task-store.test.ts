import { describe, expect, test } from "bun:test";
import { TaskManager, tasksPath } from "../../src/tasks/task-store.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { MemoryTaskStorage, createTaskManager } from "./test-helpers.ts";

function okOf<Value>(result: { ok: true; value: Value } | { ok: false; error: unknown }): Value {
  if (!result.ok) {
    throw new Error("expected ok result");
  }
  return result.value;
}

function errorCodeOf(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string };
}): string {
  return result.ok ? "ok" : (result.error?.code ?? "unknown");
}

describe("TaskManager", () => {
  test("creates tasks with monotonic ids, nextId and revision", async () => {
    const { manager } = createTaskManager();
    const first = okOf(await manager.create({ subject: "A", description: "first" }));
    const second = okOf(await manager.create({ subject: "B", description: "second" }));
    expect(first.revision).toBe(1);
    expect(first.task.id).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.task.id).toBe(2);
    const listed = okOf(await manager.list());
    expect(listed.revision).toBe(2);
    expect(listed.tasks.map((task) => task.id)).toEqual([1, 2]);
  });

  test("derives blocked from blockedBy and unblocks downstream after completion", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "dependency" }));
    const created = okOf(
      await manager.create({ subject: "B", description: "depends on A", blockedBy: [1] }),
    );
    expect(created.task.blocked).toBe(true);
    expect(created.task.blockedBy).toEqual([1]);

    okOf(await manager.update({ id: 1, status: "completed" }));
    const fetched = okOf(await manager.get(2));
    expect(fetched.task.blocked).toBe(false);
    // blockedBy 审计关系保留，blocked 只是动态解除。
    expect(fetched.task.blockedBy).toEqual([1]);
  });

  test("enforces the fixed transition table", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "x" }));

    expect(okOf(await manager.update({ id: 1, status: "in_progress" })).task.status).toBe(
      "in_progress",
    );
    expect(okOf(await manager.update({ id: 1, status: "completed" })).task.status).toBe(
      "completed",
    );

    // 反向与终态转换非法。
    const fresh = okOf(await manager.create({ subject: "B", description: "y" }));
    okOf(await manager.update({ id: fresh.task.id, status: "in_progress" }));
    expect(errorCodeOf(await manager.update({ id: fresh.task.id, status: "pending" }))).toBe(
      "invalid_transition",
    );
    // pending -> completed 合法。
    const third = okOf(await manager.create({ subject: "C", description: "z" }));
    expect(okOf(await manager.update({ id: third.task.id, status: "completed" })).task.status).toBe(
      "completed",
    );
  });

  test("rejects blocked tasks entering in_progress or completed", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "pending dep" }));
    const blocked = okOf(
      await manager.create({ subject: "B", description: "blocked", blockedBy: [1] }),
    );
    expect(blocked.task.blocked).toBe(true);
    expect(errorCodeOf(await manager.update({ id: 2, status: "in_progress" }))).toBe(
      "blocked_task",
    );
    expect(errorCodeOf(await manager.update({ id: 2, status: "completed" }))).toBe("blocked_task");
  });

  test("rejects self, missing and cyclic dependencies", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "a" }));
    okOf(await manager.create({ subject: "B", description: "b" }));

    expect(errorCodeOf(await manager.update({ id: 1, blockedBy: [1] }))).toBe("self_dependency");
    expect(errorCodeOf(await manager.update({ id: 1, blockedBy: [99] }))).toBe(
      "dependency_not_found",
    );

    // 直接环 A -> B -> A。
    okOf(await manager.update({ id: 1, blockedBy: [2] }));
    expect(errorCodeOf(await manager.update({ id: 2, blockedBy: [1] }))).toBe("cycle_dependency");

    // 间接环 A -> B, B -> C, C -> A。
    okOf(await manager.create({ subject: "C", description: "c" }));
    okOf(await manager.update({ id: 2, blockedBy: [3] }));
    expect(errorCodeOf(await manager.update({ id: 3, blockedBy: [1] }))).toBe("cycle_dependency");
  });

  test("dedupes and sorts blockedBy", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "a" }));
    okOf(await manager.create({ subject: "B", description: "b" }));
    const created = okOf(
      await manager.create({ subject: "C", description: "c", blockedBy: [2, 1, 2] }),
    );
    expect(created.task.blockedBy).toEqual([1, 2]);
  });

  test("completed tasks are immutable", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "a" }));
    okOf(await manager.update({ id: 1, status: "completed" }));
    for (const change of [
      { id: 1, subject: "renamed" },
      { id: 1, description: "changed" },
      { id: 1, status: "in_progress" as const },
      { id: 1, blockedBy: [2] },
    ]) {
      expect(errorCodeOf(await manager.update(change))).toBe("immutable_task");
    }
  });

  test("rejects unknown tasks and empty updates", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "a" }));
    expect(errorCodeOf(await manager.update({ id: 99, status: "in_progress" }))).toBe(
      "task_not_found",
    );
    expect(errorCodeOf(await manager.update({ id: 1 }))).toBe("invalid_task");
  });

  test("an in_progress task cannot add a blocking dependency", async () => {
    const { manager } = createTaskManager();
    okOf(await manager.create({ subject: "A", description: "a" }));
    const completed = okOf(await manager.create({ subject: "B", description: "done" }));
    okOf(await manager.update({ id: completed.task.id, status: "completed" }));
    const pending = okOf(await manager.create({ subject: "C", description: "pending" }));

    okOf(await manager.update({ id: 1, status: "in_progress" }));
    // 新增已完成依赖不阻塞，允许。
    expect(okOf(await manager.update({ id: 1, blockedBy: [2] })).task.blocked).toBe(false);
    // 新增未完成依赖会阻塞 in_progress 任务，拒绝。
    expect(errorCodeOf(await manager.update({ id: 1, blockedBy: [2, pending.task.id] }))).toBe(
      "blocked_task",
    );
  });

  test("rebuild recovery loads the persisted graph from a fresh manager", async () => {
    const { manager, storage } = createTaskManager("/x/tasks.json");
    okOf(await manager.create({ subject: "A", description: "a" }));
    okOf(await manager.update({ id: 1, status: "in_progress" }));

    const second = new TaskManager(storage, "/x/tasks.json");
    const listed = okOf(await second.list());
    expect(listed.revision).toBe(2);
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]?.status).toBe("in_progress");
  });

  test("detects stale revision across two managers", async () => {
    const { manager: first, storage } = createTaskManager("/x/tasks.json");
    okOf(await first.create({ subject: "A", description: "a" }));

    const second = new TaskManager(storage, "/x/tasks.json");
    okOf(await second.list()); // second 载入 revision=1

    okOf(await first.update({ id: 1, status: "in_progress" })); // first 推进到 revision=2
    expect(errorCodeOf(await second.update({ id: 1, status: "completed" }))).toBe("stale_revision");
  });

  test("serializes concurrent mutations on the same manager", async () => {
    const { manager } = createTaskManager("/x/tasks.json");
    const [first, second] = await Promise.all([
      manager.create({ subject: "A", description: "a" }),
      manager.create({ subject: "B", description: "b" }),
    ]);

    expect(okOf(first)).toMatchObject({ revision: 1, task: { id: 1 } });
    expect(okOf(second)).toMatchObject({ revision: 2, task: { id: 2 } });
    expect(okOf(await manager.list()).tasks.map((task) => task.subject)).toEqual(["A", "B"]);
  });

  test("serializes the first concurrent write across managers sharing one path", async () => {
    const storage = new MemoryTaskStorage();
    const first = new TaskManager(storage, "/x/tasks.json");
    const second = new TaskManager(storage, "/x/tasks.json");

    const [firstResult, secondResult] = await Promise.all([
      first.create({ subject: "A", description: "a" }),
      second.create({ subject: "B", description: "b" }),
    ]);

    expect(okOf(firstResult)).toMatchObject({ revision: 1, task: { id: 1 } });
    expect(okOf(secondResult)).toMatchObject({ revision: 2, task: { id: 2 } });
    expect(JSON.parse(storage.files.get("/x/tasks.json") ?? "null").tasks).toHaveLength(2);
  });

  test("holds the shared lock through event commit and rollback", async () => {
    const storage = new MemoryTaskStorage();
    const first = new TaskManager(storage, "/x/tasks.json");
    const second = new TaskManager(storage, "/x/tasks.json");
    let announceHook = (): void => {};
    const hookEntered = new Promise<void>((resolve) => {
      announceHook = resolve;
    });
    let rejectHook = (_error: Error): void => {};
    const hookGate = new Promise<void>((_resolve, reject) => {
      rejectHook = reject;
    });

    const firstMutation = first.create({ subject: "A", description: "a" }, async () => {
      announceHook();
      await hookGate;
    });
    await hookEntered;
    const secondMutation = second.create({ subject: "B", description: "b" }, async () => {});
    rejectHook(new Error("event write failed"));

    expect(errorCodeOf(await firstMutation)).toBe("io_error");
    expect(okOf(await secondMutation)).toMatchObject({ revision: 1, task: { id: 1 } });
    expect(JSON.parse(storage.files.get("/x/tasks.json") ?? "null")).toMatchObject({
      revision: 1,
      nextId: 2,
      tasks: [{ id: 1, subject: "B" }],
    });
  });

  test("does not overwrite a schema-valid graph that became structurally corrupted", async () => {
    const { manager, storage } = createTaskManager("/x/tasks.json");
    okOf(await manager.create({ subject: "A", description: "a" }));
    const graph = JSON.parse(storage.files.get("/x/tasks.json") ?? "null");
    graph.tasks[0].blockedBy = [99];
    storage.files.set("/x/tasks.json", JSON.stringify(graph));

    expect(errorCodeOf(await manager.create({ subject: "B", description: "b" }))).toBe(
      "task_store_corrupted",
    );
    expect(JSON.parse(storage.files.get("/x/tasks.json") ?? "null").tasks).toHaveLength(1);
  });

  test("detects a schema-valid same-revision content replacement", async () => {
    const { manager, storage } = createTaskManager("/x/tasks.json");
    okOf(await manager.create({ subject: "A", description: "a" }));
    const graph = JSON.parse(storage.files.get("/x/tasks.json") ?? "null");
    graph.tasks[0].subject = "externally replaced";
    storage.files.set("/x/tasks.json", JSON.stringify(graph));

    expect(errorCodeOf(await manager.create({ subject: "B", description: "b" }))).toBe(
      "stale_revision",
    );
    expect(JSON.parse(storage.files.get("/x/tasks.json") ?? "null").tasks[0].subject).toBe(
      "externally replaced",
    );
  });

  test("write failure does not advance in-memory revision or graph", async () => {
    const { manager, storage } = createTaskManager("/x/tasks.json");
    okOf(await manager.create({ subject: "A", description: "a" }));

    storage.writeError = new Error("disk full");
    expect(errorCodeOf(await manager.update({ id: 1, status: "in_progress" }))).toBe("io_error");
    storage.writeError = undefined;

    const listed = okOf(await manager.list());
    expect(listed.revision).toBe(1);
    expect(listed.tasks[0]?.status).toBe("pending");
  });

  test("corrupted and unknown-version files are rejected without overwriting", async () => {
    const storage = new MemoryTaskStorage();
    const path = "/x/tasks.json";
    storage.files.set(path, "not json");
    const corrupted = new TaskManager(storage, path);
    expect(errorCodeOf(await corrupted.load())).toBe("task_store_corrupted");
    expect(errorCodeOf(await corrupted.create({ subject: "A", description: "a" }))).toBe(
      "task_store_corrupted",
    );
    expect(storage.files.get(path)).toBe("not json");

    storage.files.set(
      path,
      JSON.stringify({ schemaVersion: 2, revision: 0, nextId: 1, tasks: [] }),
    );
    const unknown = new TaskManager(storage, path);
    expect(errorCodeOf(await unknown.load())).toBe("task_store_corrupted");
  });

  test("rejects a nextId that does not exceed every task id", async () => {
    const storage = new MemoryTaskStorage();
    storage.files.set(
      "/x/tasks.json",
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        nextId: 2,
        tasks: [
          {
            id: 2,
            subject: "A",
            description: "a",
            status: "pending",
            blockedBy: [],
            createdAt: "2026-09-14T09:00:00.000Z",
            updatedAt: "2026-09-14T09:00:00.000Z",
          },
        ],
      }),
    );
    const manager = new TaskManager(storage, "/x/tasks.json");
    expect(errorCodeOf(await manager.load())).toBe("task_store_corrupted");
  });

  test("rejects non-canonical dependencies, task order and blocked terminal states", async () => {
    const baseTask = {
      subject: "A",
      description: "a",
      status: "pending",
      blockedBy: [] as number[],
      createdAt: "2026-09-14T09:00:00.000Z",
      updatedAt: "2026-09-14T09:00:00.000Z",
    };
    for (const tasks of [
      [
        { ...baseTask, id: 2 },
        { ...baseTask, id: 1 },
      ],
      [
        { ...baseTask, id: 1 },
        { ...baseTask, id: 2, blockedBy: [1, 1] },
      ],
      [
        { ...baseTask, id: 1 },
        { ...baseTask, id: 2, status: "completed", blockedBy: [1] },
      ],
    ]) {
      const storage = new MemoryTaskStorage();
      storage.files.set(
        "/x/tasks.json",
        JSON.stringify({ schemaVersion: 1, revision: 2, nextId: 3, tasks }),
      );
      expect(errorCodeOf(await new TaskManager(storage, "/x/tasks.json").load())).toBe(
        "task_store_corrupted",
      );
    }
  });

  test("does not persist a graph when revision or nextId can no longer advance safely", async () => {
    const storage = new MemoryTaskStorage();
    storage.files.set(
      "/x/tasks.json",
      JSON.stringify({
        schemaVersion: 1,
        revision: Number.MAX_SAFE_INTEGER,
        nextId: Number.MAX_SAFE_INTEGER,
        tasks: [],
      }),
    );
    const manager = new TaskManager(storage, "/x/tasks.json");
    expect(errorCodeOf(await manager.create({ subject: "A", description: "a" }))).toBe(
      "invalid_task",
    );
    expect(JSON.parse(storage.files.get("/x/tasks.json") ?? "null").tasks).toEqual([]);
  });

  test("rejects unsafe identities before constructing a task path", () => {
    expect(() => tasksPath("/safe", "../../outside" as typeof SESSION_A, RUN_A)).toThrow();
    expect(() => tasksPath("/safe", SESSION_A, "../../outside" as typeof RUN_A)).toThrow();
  });
});
