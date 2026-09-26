import { describe, expect, test } from "bun:test";
import { testPatchPaths } from "./runner.ts";

describe("official test patch path parsing", () => {
  test("extracts and deduplicates safe repository-relative paths", () => {
    const patch = [
      "diff --git a/tests/example.py b/tests/example.py",
      "diff --git a/tests/new-case.txt b/tests/new-case.txt",
      "diff --git a/tests/example.py b/tests/example.py",
    ].join("\n");
    expect(testPatchPaths(patch)).toEqual(["tests/example.py", "tests/new-case.txt"]);
  });

  test("rejects traversal, renames, and missing diff headers", () => {
    expect(() => testPatchPaths("diff --git a/../secret b/../secret")).toThrow();
    expect(() => testPatchPaths("diff --git a/tests/a.py b/tests/b.py")).toThrow();
    expect(() => testPatchPaths("--- a/tests/a.py\n+++ b/tests/a.py")).toThrow();
  });
});
