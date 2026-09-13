import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobTool } from "../../src/tools/builtin/glob.ts";
import { GrepTool } from "../../src/tools/builtin/grep.ts";
import { ReadFileTool } from "../../src/tools/builtin/read-file.ts";
import { ToolError, type ToolExecutionContext } from "../../src/tools/types.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "./test-helpers.ts";

function context(root: string): ToolExecutionContext {
  return { workspaceRoot: root, signal: new AbortController().signal };
}

describe("read_file", () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempWorkspace();
  });
  afterEach(async () => {
    await cleanupTempWorkspace(root);
  });

  test("reads a text file", async () => {
    await writeFile(join(root, "a.txt"), "hello world");
    const result = await new ReadFileTool().execute({ path: "a.txt" }, context(root));
    expect(result.content).toBe("hello world");
    expect(result.truncated).toBe(false);
  });

  test("rejects binary files", async () => {
    await writeFile(join(root, "bin.dat"), new Uint8Array([0x61, 0x00, 0x62]));
    await expect(
      new ReadFileTool().execute({ path: "bin.dat" }, context(root)),
    ).rejects.toBeInstanceOf(ToolError);
  });

  test("rejects invalid UTF-8", async () => {
    await writeFile(join(root, "bad.txt"), new Uint8Array([0xff, 0xfe, 0xfd]));
    await expect(
      new ReadFileTool().execute({ path: "bad.txt" }, context(root)),
    ).rejects.toBeInstanceOf(ToolError);
  });

  test("truncates files larger than 256 KiB with original byte accounting", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(300 * 1024));
    const result = await new ReadFileTool().execute({ path: "big.txt" }, context(root));
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBe(300 * 1024);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(256 * 1024);
  });

  test("reports not_found for missing files", async () => {
    let caught: unknown;
    try {
      await new ReadFileTool().execute({ path: "nope.txt" }, context(root));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe("not_found");
  });
});

describe("glob", () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempWorkspace();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "a.ts"), "");
    await writeFile(join(root, "src", "b.ts"), "");
    await writeFile(join(root, "src", "nested", "c.ts"), "");
    await writeFile(join(root, "src", "readme.md"), "");
  });
  afterEach(async () => {
    await cleanupTempWorkspace(root);
  });

  test("matches files across the workspace", async () => {
    const result = await new GlobTool().execute({ pattern: "**/*.ts" }, context(root));
    expect(result.content.split("\n")).toEqual(["a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  test("scopes to a subdirectory and reports workspace-relative paths", async () => {
    const result = await new GlobTool().execute({ pattern: "**/*.ts", path: "src" }, context(root));
    expect(result.content.split("\n")).toEqual(["src/b.ts", "src/nested/c.ts"]);
  });

  test("returns empty output when nothing matches", async () => {
    const result = await new GlobTool().execute({ pattern: "*.rs" }, context(root));
    expect(result.content).toBe("");
  });
});

describe("grep", () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempWorkspace();
    await writeFile(join(root, "a.txt"), "hello world\nsecond line\nhello again\n");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "b.txt"), "hello from src\n");
  });
  afterEach(async () => {
    await cleanupTempWorkspace(root);
  });

  test("finds matching lines with file and line numbers", async () => {
    const result = await new GrepTool().execute({ pattern: "hello" }, context(root));
    expect(result.content).toBe(
      "a.txt:1:hello world\na.txt:3:hello again\nsrc/b.txt:1:hello from src",
    );
  });

  test("greps a single file", async () => {
    const result = await new GrepTool().execute({ pattern: "hello", path: "a.txt" }, context(root));
    expect(result.content).toBe("a.txt:1:hello world\na.txt:3:hello again");
  });

  test("skips binary files", async () => {
    await writeFile(join(root, "bin.dat"), new Uint8Array([0x68, 0x00, 0x65]));
    const result = await new GrepTool().execute({ pattern: "hello" }, context(root));
    expect(result.content).toBe(
      "a.txt:1:hello world\na.txt:3:hello again\nsrc/b.txt:1:hello from src",
    );
  });

  test("rejects invalid regular expressions", async () => {
    await expect(
      new GrepTool().execute({ pattern: "([unclosed" }, context(root)),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
