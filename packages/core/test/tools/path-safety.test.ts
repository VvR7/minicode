import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafePath } from "../../src/tools/fs-safety.ts";
import { ToolError } from "../../src/tools/types.ts";

describe("resolveSafePath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "minicode-path-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "minicode-out-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("accepts a relative path inside the workspace", async () => {
    await writeFile(join(root, "a.txt"), "hello");
    expect(await resolveSafePath(root, "a.txt")).toBe(join(root, "a.txt"));
  });

  test("rejects absolute paths", async () => {
    await expect(resolveSafePath(root, join(outside, "x.txt"))).rejects.toBeInstanceOf(ToolError);
  });

  test("rejects .. traversal", async () => {
    await expect(resolveSafePath(root, "../outside")).rejects.toBeInstanceOf(ToolError);
    await expect(resolveSafePath(root, "a/../../outside")).rejects.toBeInstanceOf(ToolError);
  });

  test("rejects symlink escape", async () => {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "link"));
    await expect(resolveSafePath(root, "link/secret.txt")).rejects.toBeInstanceOf(ToolError);
  });

  test("returns the lexical path when the target does not exist", async () => {
    expect(await resolveSafePath(root, "missing.txt")).toBe(join(root, "missing.txt"));
  });
});
