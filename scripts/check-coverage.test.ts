import { describe, expect, test } from "bun:test";

import {
  assessCoveragePolicy,
  CoverageReportError,
  evaluateCoverage,
  parseLcov,
} from "./check-coverage.ts";

const repositoryRoot = process.cwd();

function record(
  file: string,
  counts: {
    readonly functionsFound: number;
    readonly functionsTotal: number;
    readonly linesFound: number;
    readonly linesTotal: number;
  },
): string {
  return [
    `SF:${file}`,
    `FNF:${counts.functionsTotal}`,
    `FNH:${counts.functionsFound}`,
    `LF:${counts.linesTotal}`,
    `LH:${counts.linesFound}`,
    "end_of_record",
    "",
  ].join("\n");
}

describe("coverage policy", () => {
  test("accepts a complete report above both thresholds", () => {
    const file = "packages/core/src/app.ts";
    const records = parseLcov(
      record(file, {
        functionsFound: 9,
        functionsTotal: 10,
        linesFound: 9,
        linesTotal: 10,
      }),
      repositoryRoot,
    );

    const evaluation = evaluateCoverage([file], records);
    expect(assessCoveragePolicy(evaluation, 1)).toEqual({
      functionPercent: 90,
      linePercent: 90,
      violations: [],
    });
  });

  test("rejects a report that omits a production file", () => {
    const evaluation = evaluateCoverage(["packages/core/src/app.ts"], new Map());

    expect(assessCoveragePolicy(evaluation, 1).violations).toContain(
      "1 production file(s) are missing from LCOV",
    );
  });

  test("rejects line or function coverage below 81 percent", () => {
    const file = "packages/core/src/app.ts";
    const records = parseLcov(
      record(file, {
        functionsFound: 8,
        functionsTotal: 10,
        linesFound: 8,
        linesTotal: 10,
      }),
      repositoryRoot,
    );

    const violations = assessCoveragePolicy(evaluateCoverage([file], records), 1).violations;
    expect(violations).toContain("line coverage is below 81%");
    expect(violations).toContain("function coverage is below 81%");
  });

  test("rejects zero aggregate denominators and an empty source set", () => {
    const file = "packages/core/src/app.ts";
    const records = parseLcov(
      record(file, {
        functionsFound: 0,
        functionsTotal: 0,
        linesFound: 0,
        linesTotal: 0,
      }),
      repositoryRoot,
    );

    const policy = assessCoveragePolicy(evaluateCoverage([file], records), 0);
    expect(policy.violations).toContain("no production source files were discovered");
    expect(policy.violations).toContain("aggregate line coverage denominator is zero");
    expect(policy.violations).toContain("aggregate function coverage denominator is zero");
  });

  test("rejects malformed and incomplete LCOV records", () => {
    expect(() =>
      parseLcov(
        "SF:packages/core/src/app.ts\nFNF:not-a-number\nFNH:0\nLF:1\nLH:0\nend_of_record\n",
        repositoryRoot,
      ),
    ).toThrow(CoverageReportError);
    expect(() =>
      parseLcov("SF:packages/core/src/app.ts\nFNF:1\nend_of_record\n", repositoryRoot),
    ).toThrow("incomplete LCOV record");
  });
});
