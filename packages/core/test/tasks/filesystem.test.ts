import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager, nodeTaskStorage, tasksPath } from "../../src/tasks/task-store.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";

describe("task filesystem behavior", () => {
  test("writes tasks.json only under the run directory with private permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-tasks-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-tasks-ws-"));
    const path = tasksPath(home, SESSION_A, RUN_A);
    try {
      await mkdir(join(home, "sessions", SESSION_A, "runs", RUN_A), { recursive: true });
      const manager = new TaskManager(nodeTaskStorage, path);
      const created = await manager.create({ subject: "read", description: "inspect files" });
      expect(created.ok).toBe(true);

      const fileStat = await stat(path);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(await stat(join(workspace, "tasks.json")).catch(() => undefined)).toBeUndefined();
      expect(await stat(join(process.cwd(), "tasks.json")).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
