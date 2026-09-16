import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveToolPath } from "../../src/tools/fs-safety.ts";
import { ToolError } from "../../src/tools/types.ts";

describe("resolveToolPath", () => {
  const root = "/tmp/minicode-workspace";

  test("resolves relative paths against the workspace", () => {
    expect(resolveToolPath(root, "src/index.ts")).toBe(join(root, "src/index.ts"));
  });

  test("allows absolute paths", () => {
    expect(resolveToolPath(root, "/tmp/external.txt")).toBe("/tmp/external.txt");
  });

  test("rejects every explicit parent segment", () => {
    expect(() => resolveToolPath(root, "../outside")).toThrow(ToolError);
    expect(() => resolveToolPath(root, "a/../outside")).toThrow(ToolError);
    expect(() => resolveToolPath(root, "a\\..\\outside")).toThrow(ToolError);
  });
});
