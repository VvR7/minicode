import { join } from "node:path";

export const DATASET_NAME = "MariusHobbhahn/swe-bench-verified-mini";
export const DATASET_REVISION = "b316c349947c29963fce3f4a65967c9807a4b673";
export const SWE_BENCH_COMMIT = "02e7a74ffd0b707aab73d203fe87bdc7c76afc8e";
export const TASK_ASSETS_COMMIT = "3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d";
export const PI_BENCH_REFERENCE_COMMIT = "8fbd7c6015a1ebaf1fd1d2bf257d066106aa3bb5";
export const DATASET_TOTAL = 50;
export const BENCHMARK_LABEL = "dev.minicode.swe-bench";
export const BENCHMARK_LABEL_VALUE = "verified-mini";
export const DEFAULT_RESULTS_DIRECTORY = "benchmark-results/verified-mini";
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_EVALUATION_TIMEOUT_MS = 30 * 60 * 1000;
export const BENCHMARK_MAX_STEPS = 1000;
export const BENCHMARK_CONTEXT_TOKENS = 1_000_000;
export const CRANE_VERSION = "v0.22.1";
export const CRANE_LINUX_X86_64_SHA256 =
  "0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0";

/** 判断宿主是否显式配置了常见 HTTP(S) 代理环境变量。 */
export function usesHostProxy(): boolean {
  return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) =>
    Boolean(Bun.env[name]),
  );
}

/** 返回仓库内固定任务数据目录。 */
export function taskDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, "tasks", "verified-mini");
}

/** 返回本地、被 gitignore 的 SWE-bench 工具缓存目录。 */
export function cacheDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, ".cache", "swe-bench");
}

/** 根据 instance id 生成 Epoch SWE-bench x86_64 image 名称。 */
export function imageForTask(taskId: string): string {
  return `ghcr.io/epoch-research/swe-bench.eval.x86_64.${taskId}:latest`;
}
