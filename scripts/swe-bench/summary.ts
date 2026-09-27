import type { ArtifactStore } from "./artifact-store.ts";
import { DATASET_TOTAL } from "./constants.ts";
import type { Summary, SweBenchTask } from "./types.ts";

/** 汇总结果目录中的 canonical 终态，历史 attempts 不重复计数。 */
export async function buildSummary(
  store: ArtifactStore,
  tasks: readonly SweBenchTask[],
  invocation: { readonly selected: number; readonly executed: number; readonly skipped: number },
): Promise<Summary> {
  const results = (await Promise.all(tasks.map((task) => store.readResult(task.id)))).filter(
    (result) => result !== undefined,
  );
  const resolved = results.filter((result) => result.status === "resolved").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const timeout = results.filter((result) => result.status === "timeout").length;
  const cleanupFailed = results.filter((result) => result.status === "cleanup_failed").length;
  const total = results.length;
  return {
    datasetTotal: DATASET_TOTAL,
    selected: invocation.selected,
    executed: invocation.executed,
    skipped: invocation.skipped,
    total,
    resolved,
    failed,
    timeout,
    cleanupFailed,
    resolveRate: total === 0 ? 0 : resolved / total,
  };
}

/** 输出固定、便于 CI 与人工阅读的汇总字段。 */
export function formatSummary(summary: Summary): string {
  return [
    `Dataset Total: ${summary.datasetTotal}`,
    `Selected: ${summary.selected}`,
    `Executed: ${summary.executed}`,
    `Skipped: ${summary.skipped}`,
    `Total: ${summary.total}`,
    `Resolved: ${summary.resolved}`,
    `Failed: ${summary.failed}`,
    `Timeout: ${summary.timeout}`,
    `CleanupFailed: ${summary.cleanupFailed}`,
    `Resolve Rate: ${(summary.resolveRate * 100).toFixed(2)}%`,
  ].join("\n");
}

/** 生成包含每题成功或失败原因的 Markdown 实验报告。 */
export async function buildMarkdownReport(
  store: ArtifactStore,
  tasks: readonly SweBenchTask[],
  summary: Summary,
): Promise<string> {
  const rows: string[] = [];
  for (const task of tasks) {
    const result = await store.readResult(task.id);
    if (result === undefined) continue;
    const evaluation = result.evaluation.attempted
      ? result.evaluation.resolved
        ? "official F2P/P2P passed"
        : (result.evaluation.reason ?? "official evaluation failed")
      : "not evaluated";
    rows.push(`| ${task.id} | ${result.status} | ${result.reason} | ${evaluation} |`);
  }
  return [
    "# SWE-bench Verified Mini Report",
    "",
    "```text",
    formatSummary(summary),
    "```",
    "",
    "| Task | Status | Primary reason | Evaluation |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
