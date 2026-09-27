import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATASET_NAME,
  DATASET_REVISION,
  DATASET_TOTAL,
  PI_BENCH_REFERENCE_COMMIT,
  SWE_BENCH_COMMIT,
  TASK_ASSETS_COMMIT,
} from "./constants.ts";
import type { SweBenchTask, TaskManifest } from "./types.ts";

/** 读取并严格校验固定 Verified Mini manifest 与 50 个 task。 */
export async function loadTasks(directory: string): Promise<readonly SweBenchTask[]> {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TaskManifest;
  validateManifest(manifest);
  const tasks = await Promise.all(
    manifest.taskIds.map(async (id) => {
      const task = JSON.parse(
        await readFile(join(directory, `${id}.json`), "utf8"),
      ) as SweBenchTask;
      validateTask(task, id);
      return task;
    }),
  );
  return tasks;
}

/** 校验 manifest 的来源 pin、数量、顺序和 ID 唯一性。 */
export function validateManifest(manifest: TaskManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.dataset !== DATASET_NAME ||
    manifest.datasetRevision !== DATASET_REVISION ||
    manifest.sweBenchCommit !== SWE_BENCH_COMMIT ||
    manifest.taskAssetsCommit !== TASK_ASSETS_COMMIT ||
    manifest.piBenchReferenceCommit !== PI_BENCH_REFERENCE_COMMIT
  ) {
    throw new Error("verified-mini manifest source pins do not match the benchmark constants");
  }
  if (manifest.taskIds.length !== DATASET_TOTAL) {
    throw new Error(`verified-mini manifest must contain exactly ${DATASET_TOTAL} task ids`);
  }
  const sorted = [...manifest.taskIds].sort();
  if (
    new Set(sorted).size !== DATASET_TOTAL ||
    sorted.some((id, index) => id !== manifest.taskIds[index])
  ) {
    throw new Error("verified-mini task ids must be unique and sorted");
  }
}

/** 校验单个 task 包含运行与官方评分所需字段，且不携带 gold patch。 */
export function validateTask(task: SweBenchTask, expectedId: string): void {
  if (task.id !== expectedId) throw new Error(`task id mismatch for ${expectedId}`);
  const strings = [
    task.repo,
    task.commit,
    task.prompt,
    task.testPatch,
    task.version,
    task.evalScript,
    task.logParser,
    task.evalType,
  ];
  if (strings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`task ${expectedId} has missing required fields`);
  }
  if (!Array.isArray(task.failToPass) || !Array.isArray(task.passToPass)) {
    throw new Error(`task ${expectedId} has invalid test lists`);
  }
  if ("expectedDiff" in task || "patch" in task) {
    throw new Error(`task ${expectedId} must not contain a gold patch`);
  }
}

/** 按固定 manifest 顺序选择 task，并让 limit 表示实际待执行数量。 */
export function selectTasks(
  tasks: readonly SweBenchTask[],
  taskId: string | undefined,
  limit: number | undefined,
  shouldSkip: (task: SweBenchTask) => boolean,
): { selected: readonly SweBenchTask[]; skipped: number } {
  const filtered = taskId === undefined ? tasks : tasks.filter((task) => task.id === taskId);
  if (taskId !== undefined && filtered.length === 0) throw new Error(`unknown task: ${taskId}`);
  const selected: SweBenchTask[] = [];
  let skipped = 0;
  for (const task of filtered) {
    if (shouldSkip(task)) {
      skipped += 1;
      continue;
    }
    if (limit === undefined || selected.length < limit) selected.push(task);
    if (limit !== undefined && selected.length >= limit) break;
  }
  return { selected, skipped };
}
