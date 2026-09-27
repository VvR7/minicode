import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "./artifact-store.ts";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_EVALUATION_TIMEOUT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  DEFAULT_RESULTS_DIRECTORY,
  DEFAULT_STARTUP_TIMEOUT_MS,
  taskDirectory,
} from "./constants.ts";
import { DockerController } from "./docker.ts";
import { BenchmarkLock } from "./lock.ts";
import { terminateActiveCommands } from "./process.ts";
import type { SecretRedactor } from "./redactor.ts";
import { buildMarkdownReport, buildSummary, formatSummary } from "./summary.ts";
import { loadTasks, selectTasks } from "./task-loader.ts";
import type { RunnerOptions, TaskResult } from "./types.ts";
import { SweBenchRunner } from "./runner.ts";

/** 解析正整数 CLI 参数。 */
function positiveInteger(name: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} requires a positive integer`);
  }
  return Number(raw);
}

/** 将分钟参数转换为毫秒。 */
function minutes(name: string, raw: string | undefined): number {
  return positiveInteger(name, raw) * 60 * 1000;
}

/** 解析 benchmark CLI，未知参数立即失败。 */
export function parseOptions(args: readonly string[], repositoryRoot: string): RunnerOptions {
  let taskId: string | undefined;
  let limit: number | undefined;
  let resume = false;
  let force = false;
  let cleanupStale = false;
  let resultsDirectory = resolve(repositoryRoot, DEFAULT_RESULTS_DIRECTORY);
  let agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;
  let pullTimeoutMs = DEFAULT_PULL_TIMEOUT_MS;
  let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  let evaluationTimeoutMs = DEFAULT_EVALUATION_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--task":
        if (value === undefined) throw new Error("--task requires an instance id");
        taskId = value;
        index += 1;
        break;
      case "--limit":
        limit = positiveInteger("--limit", value);
        index += 1;
        break;
      case "--resume":
        resume = true;
        break;
      case "--force":
        force = true;
        break;
      case "--cleanup-stale":
        cleanupStale = true;
        break;
      case "--results":
        if (value === undefined) throw new Error("--results requires a path");
        resultsDirectory = resolve(repositoryRoot, value);
        index += 1;
        break;
      case "--agent-timeout-minutes":
        agentTimeoutMs = minutes(arg, value);
        index += 1;
        break;
      case "--pull-timeout-minutes":
        pullTimeoutMs = minutes(arg, value);
        index += 1;
        break;
      case "--startup-timeout-seconds":
        startupTimeoutMs = positiveInteger(arg, value) * 1000;
        index += 1;
        break;
      case "--evaluation-timeout-minutes":
        evaluationTimeoutMs = minutes(arg, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (taskId !== undefined && limit !== undefined && limit !== 1) {
    throw new Error("--task may only be combined with --limit 1");
  }
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(limit === undefined ? {} : { limit }),
    resume,
    force,
    cleanupStale,
    resultsDirectory,
    agentTimeoutMs,
    pullTimeoutMs,
    startupTimeoutMs,
    evaluationTimeoutMs,
  };
}

/** 显式清理由 metadata 和专用 label 共同确认的 stale 资源。 */
async function cleanupStale(
  repositoryRoot: string,
  store: ArtifactStore,
  lock: BenchmarkLock,
): Promise<void> {
  if (await lock.heldByLiveProcess()) {
    throw new Error("an active SWE-bench runner owns the global lock");
  }
  const docker = new DockerController(repositoryRoot);
  const state = await store.readRunState();
  const labeled = await docker.labeledContainers();
  if (labeled.length === 0) {
    if (state?.image !== undefined && (await docker.imageExists(state.image))) {
      throw new Error(
        "stale image exists without a labeled container; refusing automatic deletion",
      );
    }
    await lock.removeStale();
    console.log("No stale benchmark Docker resources found; stale lock removed if present.");
    return;
  }
  if (state?.image === undefined) throw new Error("labeled containers exist without run metadata");
  const recorded = [state.agentContainerId, state.evaluationContainerId].filter(
    (value): value is string => value !== undefined,
  );
  if (
    labeled.length !== recorded.length ||
    labeled.some((id) => !recorded.includes(id)) ||
    !(await Promise.all(labeled.map((id) => docker.verifyOwnership(id, state)))).every(Boolean)
  ) {
    throw new Error("stale resource ownership could not be confirmed; refusing automatic deletion");
  }
  const result = await docker.cleanup(recorded, state.image, DEFAULT_STARTUP_TIMEOUT_MS);
  if (!result.succeeded) throw new Error(`stale cleanup failed: ${JSON.stringify(result)}`);
  await lock.removeStale();
  console.log(`Removed ${recorded.length} stale container(s) and ${state.image}.`);
}

/** 执行完整 CLI 生命周期、串行任务与累计汇总。 */
export async function runCli(
  args: readonly string[],
  repositoryRoot: string,
  store: ArtifactStore,
  redactor: SecretRedactor,
): Promise<number> {
  const options = parseOptions(args, repositoryRoot);
  const lock = new BenchmarkLock(join(tmpdir(), "minicode-swe-bench"));
  await store.initialize();
  if (options.cleanupStale) {
    await cleanupStale(repositoryRoot, store, lock);
    return 0;
  }
  await lock.acquire();
  let interrupted = false;
  const handleSignal = (): void => {
    interrupted = true;
    terminateActiveCommands();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  try {
    const docker = new DockerController(repositoryRoot);
    const stale = await docker.labeledContainers();
    if (stale.length > 0) {
      throw new Error(`stale benchmark containers found: ${stale.join(", ")}; run --cleanup-stale`);
    }
    const tasks = await loadTasks(taskDirectory(repositoryRoot));
    const prior = new Map<string, TaskResult | undefined>();
    for (const task of tasks) prior.set(task.id, await store.readResult(task.id));
    if (!options.resume && !options.force) {
      const existing = tasks.find((task) => prior.get(task.id) !== undefined);
      if (existing !== undefined) {
        throw new Error(
          `canonical result already exists for ${existing.id}; use --resume or --force`,
        );
      }
    }
    const selection = selectTasks(tasks, options.taskId, options.limit, (task) => {
      const result = prior.get(task.id);
      return (
        options.resume &&
        !options.force &&
        result !== undefined &&
        ["resolved", "failed", "timeout"].includes(result.status)
      );
    });
    const runner = new SweBenchRunner(repositoryRoot, options, store, redactor);
    if (selection.selected.length > 0) await runner.prepareRuntime();
    let executed = 0;
    for (const task of selection.selected) {
      if (interrupted) break;
      console.log(`\n[${executed + 1}/${selection.selected.length}] ${task.id}`);
      const result = await runner.runTask(task);
      executed += 1;
      console.log(`${task.id}: ${result.status} (${result.reason})`);
      const summary = await buildSummary(store, tasks, {
        selected: selection.selected.length,
        executed,
        skipped: selection.skipped,
      });
      await store.writeSummary(summary);
      await store.writeRootText("summary.md", await buildMarkdownReport(store, tasks, summary));
      if (result.status === "cleanup_failed") break;
    }
    const summary = await buildSummary(store, tasks, {
      selected: selection.selected.length,
      executed,
      skipped: selection.skipped,
    });
    await store.writeSummary(summary);
    await store.writeRootText("summary.md", await buildMarkdownReport(store, tasks, summary));
    console.log(`\n${formatSummary(summary)}`);
    return interrupted || summary.cleanupFailed > 0 ? 1 : 0;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await lock.release();
  }
}
