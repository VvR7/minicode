#!/usr/bin/env bun

import { resolve } from "node:path";
import { ArtifactStore } from "./swe-bench/artifact-store.ts";
import { parseOptions, runCli } from "./swe-bench/cli.ts";
import { SecretRedactor } from "./swe-bench/redactor.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

/** 构造只包含实际注入敏感值的统一脱敏器。 */
function createRedactor(): SecretRedactor {
  const { LLM_API_KEY, LLM_BASE_URL } = Bun.env;
  return new SecretRedactor([LLM_API_KEY, LLM_BASE_URL]);
}

/** 解析一次 options 以确定结果目录，再进入完整 CLI 生命周期。 */
async function main(): Promise<number> {
  const redactor = createRedactor();
  const options = parseOptions(Bun.argv.slice(2), repositoryRoot);
  const store = new ArtifactStore(options.resultsDirectory, redactor);
  return runCli(Bun.argv.slice(2), repositoryRoot, store, redactor);
}

try {
  process.exitCode = await main();
} catch (error) {
  const redactor = createRedactor();
  console.error(
    `error: ${redactor.redact(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
}
