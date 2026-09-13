#!/usr/bin/env bun

import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_LCOV_PATH = "coverage/lcov.info";
const MINIMUM_COVERAGE_PERCENT = 81;
const SOURCE_GLOB = "packages/*/src/**/*.ts";

interface CoverageCounts {
  readonly found: number;
  readonly total: number;
}

interface FileCoverage {
  readonly functions: CoverageCounts;
  readonly lines: CoverageCounts;
}

interface CoverageSummary {
  readonly functions: CoverageCounts;
  readonly lines: CoverageCounts;
}

export interface CoverageEvaluation extends CoverageSummary {
  readonly missingFiles: readonly string[];
}

export interface CoveragePolicyResult {
  readonly functionPercent: number;
  readonly linePercent: number;
  readonly violations: readonly string[];
}

export class CoverageReportError extends Error {
  override readonly name = "CoverageReportError";
}

function normalizePath(path: string, repositoryRoot: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(repositoryRoot, path);
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

/** 解析 Bun 生成的 LCOV；重复记录会合并，避免不同测试分片重复计算同一源码。 */
export function parseLcov(contents: string, repositoryRoot: string): Map<string, FileCoverage> {
  const records = new Map<string, FileCoverage>();
  let sourceFile: string | undefined;
  let functionsFound: number | undefined;
  let functionsTotal: number | undefined;
  let linesFound: number | undefined;
  let linesTotal: number | undefined;

  const parseCount = (line: string, prefix: string): number => {
    const value = line.slice(prefix.length);
    if (!/^\d+$/u.test(value)) {
      throw new CoverageReportError(`invalid ${prefix.slice(0, -1)} count: ${value}`);
    }
    const count = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(count)) {
      throw new CoverageReportError(`unsafe ${prefix.slice(0, -1)} count: ${value}`);
    }
    return count;
  };

  const saveRecord = (): void => {
    if (sourceFile === undefined) {
      return;
    }
    if (
      functionsFound === undefined ||
      functionsTotal === undefined ||
      linesFound === undefined ||
      linesTotal === undefined
    ) {
      throw new CoverageReportError(`incomplete LCOV record: ${sourceFile}`);
    }
    if (functionsFound > functionsTotal || linesFound > linesTotal) {
      throw new CoverageReportError(`invalid covered/total counts: ${sourceFile}`);
    }
    const existing = records.get(sourceFile);
    records.set(sourceFile, {
      functions: {
        found: Math.max(existing?.functions.found ?? 0, functionsFound),
        total: Math.max(existing?.functions.total ?? 0, functionsTotal),
      },
      lines: {
        found: Math.max(existing?.lines.found ?? 0, linesFound),
        total: Math.max(existing?.lines.total ?? 0, linesTotal),
      },
    });
    sourceFile = undefined;
    functionsFound = undefined;
    functionsTotal = undefined;
    linesFound = undefined;
    linesTotal = undefined;
  };

  for (const line of contents.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      saveRecord();
      sourceFile = normalizePath(line.slice(3), repositoryRoot);
    } else if (line.startsWith("FNF:")) {
      functionsTotal = parseCount(line, "FNF:");
    } else if (line.startsWith("FNH:")) {
      functionsFound = parseCount(line, "FNH:");
    } else if (line.startsWith("LF:")) {
      linesTotal = parseCount(line, "LF:");
    } else if (line.startsWith("LH:")) {
      linesFound = parseCount(line, "LH:");
    } else if (line === "end_of_record") {
      saveRecord();
    }
  }
  saveRecord();
  return records;
}

/** 汇总所有生产源码；未加载的文件单独报告，不能靠覆盖率分母缺失蒙混过关。 */
export function evaluateCoverage(
  productionFiles: readonly string[],
  records: ReadonlyMap<string, FileCoverage>,
): CoverageEvaluation {
  const missingFiles: string[] = [];
  let functionsFound = 0;
  let functionsTotal = 0;
  let linesFound = 0;
  let linesTotal = 0;

  for (const file of productionFiles) {
    const coverage = records.get(file);
    if (coverage === undefined) {
      missingFiles.push(file);
      continue;
    }
    functionsFound += coverage.functions.found;
    functionsTotal += coverage.functions.total;
    linesFound += coverage.lines.found;
    linesTotal += coverage.lines.total;
  }

  return {
    functions: { found: functionsFound, total: functionsTotal },
    lines: { found: linesFound, total: linesTotal },
    missingFiles,
  };
}

function percent(counts: CoverageCounts): number {
  return counts.total === 0 ? 0 : (counts.found / counts.total) * 100;
}

/** 对聚合分母采用 fail-closed，单个纯类型文件仍可合法地贡献零个可执行项。 */
export function assessCoveragePolicy(
  evaluation: CoverageEvaluation,
  productionFileCount: number,
): CoveragePolicyResult {
  const linePercent = percent(evaluation.lines);
  const functionPercent = percent(evaluation.functions);
  const violations: string[] = [];
  const lineCountsValid =
    Number.isSafeInteger(evaluation.lines.found) &&
    Number.isSafeInteger(evaluation.lines.total) &&
    evaluation.lines.found >= 0 &&
    evaluation.lines.total >= 0 &&
    evaluation.lines.found <= evaluation.lines.total;
  const functionCountsValid =
    Number.isSafeInteger(evaluation.functions.found) &&
    Number.isSafeInteger(evaluation.functions.total) &&
    evaluation.functions.found >= 0 &&
    evaluation.functions.total >= 0 &&
    evaluation.functions.found <= evaluation.functions.total;

  if (!Number.isSafeInteger(productionFileCount) || productionFileCount <= 0) {
    violations.push("no production source files were discovered");
  }
  if (evaluation.missingFiles.length > 0) {
    violations.push(`${evaluation.missingFiles.length} production file(s) are missing from LCOV`);
  }
  if (!lineCountsValid || !Number.isFinite(linePercent)) {
    violations.push("aggregate line coverage counts are invalid");
  } else if (evaluation.lines.total === 0) {
    violations.push("aggregate line coverage denominator is zero");
  } else if (linePercent < MINIMUM_COVERAGE_PERCENT) {
    violations.push(`line coverage is below ${MINIMUM_COVERAGE_PERCENT}%`);
  }
  if (!functionCountsValid || !Number.isFinite(functionPercent)) {
    violations.push("aggregate function coverage counts are invalid");
  } else if (evaluation.functions.total === 0) {
    violations.push("aggregate function coverage denominator is zero");
  } else if (functionPercent < MINIMUM_COVERAGE_PERCENT) {
    violations.push(`function coverage is below ${MINIMUM_COVERAGE_PERCENT}%`);
  }

  return { functionPercent, linePercent, violations };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (args.length > 1) {
    console.error("usage: bun run coverage:check [lcov-path]");
    return 2;
  }

  const repositoryRoot = resolve(import.meta.dir, "..");
  const lcovPath = resolve(repositoryRoot, args[0] ?? DEFAULT_LCOV_PATH);
  const lcovFile = Bun.file(lcovPath);
  if (!(await lcovFile.exists())) {
    console.error(`coverage error: LCOV file not found: ${relative(repositoryRoot, lcovPath)}`);
    return 1;
  }

  const sourceGlob = new Bun.Glob(SOURCE_GLOB);
  const productionFiles = [...sourceGlob.scanSync({ cwd: repositoryRoot, onlyFiles: true })].sort();
  let records: Map<string, FileCoverage>;
  try {
    records = parseLcov(await lcovFile.text(), repositoryRoot);
  } catch (error) {
    const message = error instanceof CoverageReportError ? error.message : "unknown parse failure";
    console.error(`coverage error: invalid LCOV (${message})`);
    return 1;
  }
  const evaluation = evaluateCoverage(productionFiles, records);
  const policy = assessCoveragePolicy(evaluation, productionFiles.length);

  if (evaluation.missingFiles.length > 0) {
    console.error("coverage error: production files missing from LCOV:");
    for (const file of evaluation.missingFiles) {
      console.error(`  - ${file}`);
    }
  }

  console.log(
    `coverage: lines=${policy.linePercent.toFixed(2)}% functions=${policy.functionPercent.toFixed(2)}% files=${productionFiles.length}`,
  );

  for (const violation of policy.violations) {
    console.error(`coverage error: ${violation}`);
  }
  return policy.violations.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
