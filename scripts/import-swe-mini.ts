import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATASET_NAME,
  DATASET_REVISION,
  PI_BENCH_REFERENCE_COMMIT,
  SWE_BENCH_COMMIT,
  TASK_ASSETS_COMMIT,
} from "./swe-bench/constants.ts";

interface SourceInstance {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly problem_statement: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: string | readonly string[];
  readonly PASS_TO_PASS: string | readonly string[];
  readonly version: string;
}

/** 解析 Hugging Face 导出的 JSON array 或 JSONL。 */
function parseInstances(content: string): readonly SourceInstance[] {
  try {
    return JSON.parse(content) as SourceInstance[];
  } catch {
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SourceInstance);
  }
}

/** 兼容 HF 将测试列表编码为 JSON 字符串的 schema。 */
function parseTests(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? (JSON.parse(value) as readonly string[]) : value;
}

/** 从固定 task asset YAML 中读取官方 parser 与 eval type。 */
function yamlField(yaml: string, name: string): string {
  const match = yaml.match(new RegExp(`^${name}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m"));
  if (match?.[1] === undefined) throw new Error(`missing ${name} in task.yaml`);
  return match[1].trim();
}

/** 下载固定 revision 的官方 eval asset。 */
async function fetchAsset(taskId: string, name: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/SWE-bench/swe-bench-tasks/${TASK_ASSETS_COMMIT}/tasks/${taskId}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url}: ${response.status}`);
  return response.text();
}

/** 生成固定 50-task 数据，故意不把 gold patch 写入仓库。 */
async function main(): Promise<void> {
  const input = process.argv[2];
  if (input === undefined)
    throw new Error("usage: bun run scripts/import-swe-mini.ts <dataset.jsonl>");
  const expected = JSON.parse(
    await readFile(join(import.meta.dir, "swe-bench", "verified-mini-task-ids.json"), "utf8"),
  ) as readonly string[];
  const instances = parseInstances(await readFile(input, "utf8"));
  const byId = new Map(instances.map((instance) => [instance.instance_id, instance]));
  const actual = [...byId.keys()].sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error("downloaded dataset does not match the fixed Verified Mini 50-task id set");
  }

  const output = join(import.meta.dir, "..", "tasks", "verified-mini");
  await mkdir(output, { recursive: true });
  for (const id of expected) {
    const instance = byId.get(id);
    if (instance === undefined) throw new Error(`missing task ${id}`);
    const [evalScript, taskYaml] = await Promise.all([
      fetchAsset(id, "eval.sh"),
      fetchAsset(id, "task.yaml"),
    ]);
    const task = {
      id,
      repo: instance.repo,
      commit: instance.base_commit,
      prompt: instance.problem_statement,
      testPatch: instance.test_patch,
      failToPass: parseTests(instance.FAIL_TO_PASS),
      passToPass: parseTests(instance.PASS_TO_PASS),
      version: instance.version,
      evalScript,
      logParser: yamlField(taskYaml, "log_parser"),
      evalType: yamlField(taskYaml, "eval_type"),
    };
    await writeFile(join(output, `${id}.json`), `${JSON.stringify(task, null, 2)}\n`);
  }
  const manifest = {
    schemaVersion: 1,
    dataset: DATASET_NAME,
    datasetRevision: DATASET_REVISION,
    sweBenchCommit: SWE_BENCH_COMMIT,
    taskAssetsCommit: TASK_ASSETS_COMMIT,
    piBenchReferenceCommit: PI_BENCH_REFERENCE_COMMIT,
    taskIds: expected,
  };
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${expected.length} fixed Verified Mini tasks in ${output}`);
}

await main();
