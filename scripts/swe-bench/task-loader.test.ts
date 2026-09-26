import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadTasks, selectTasks, validateManifest, validateTask } from "./task-loader.ts";
import {
  DATASET_NAME,
  DATASET_REVISION,
  PI_BENCH_REFERENCE_COMMIT,
  SWE_BENCH_COMMIT,
  TASK_ASSETS_COMMIT,
} from "./constants.ts";
import type { SweBenchTask, TaskManifest } from "./types.ts";
import ids from "./verified-mini-task-ids.json";

function task(id: string): SweBenchTask {
  return {
    id,
    repo: "owner/repo",
    commit: "abc",
    prompt: "fix it",
    testPatch: "diff --git",
    failToPass: ["test_target"],
    passToPass: ["test_existing"],
    version: "1",
    evalScript: "#!/bin/bash",
    logParser: "parse_log_pytest",
    evalType: "pass_and_fail",
  };
}

describe("fixed task loading", () => {
  test("loads the committed fixed dataset in deterministic order", async () => {
    const tasks = await loadTasks(join(import.meta.dir, "..", "..", "tasks", "verified-mini"));
    expect(tasks).toHaveLength(50);
    expect(tasks[0]?.id).toBe("django__django-11790");
    expect(tasks.at(-1)?.id).toBe("sphinx-doc__sphinx-9698");
  });

  test("accepts only the pinned sorted 50-task manifest", () => {
    const manifest: TaskManifest = {
      schemaVersion: 1,
      dataset: DATASET_NAME,
      datasetRevision: DATASET_REVISION,
      sweBenchCommit: SWE_BENCH_COMMIT,
      taskAssetsCommit: TASK_ASSETS_COMMIT,
      piBenchReferenceCommit: PI_BENCH_REFERENCE_COMMIT,
      taskIds: ids,
    };
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(() => validateManifest({ ...manifest, taskIds: ids.slice(1) })).toThrow();
  });

  test("rejects task files that contain a gold patch", () => {
    expect(() => validateTask({ ...task("one"), patch: "gold" } as SweBenchTask, "one")).toThrow();
  });

  test("limit counts tasks actually selected after resume skips", () => {
    const tasks = [task("one"), task("two"), task("three")];
    const selection = selectTasks(tasks, undefined, 1, (candidate) => candidate.id === "one");
    expect(selection.selected.map((candidate) => candidate.id)).toEqual(["two"]);
    expect(selection.skipped).toBe(1);
  });
});
