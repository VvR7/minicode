import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSessionStorage } from "../../src/session/storage.ts";

describe("nodeSessionStorage", () => {
  test("returns undefined for a missing file and empty list for a missing directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-storage-"));
    try {
      expect(await nodeSessionStorage.readFile(join(home, "missing.txt"))).toBeUndefined();
      expect(await nodeSessionStorage.listDirectories(join(home, "missing"))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rethrows non-ENOENT read and list failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-storage-"));
    try {
      await writeFile(join(home, "file.txt"), "content", "utf8");
      expect(nodeSessionStorage.readFile(join(home, "file.txt", "child"))).rejects.toThrow();
      expect(nodeSessionStorage.listDirectories(join(home, "file.txt"))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("creates directories with private permissions and removes them recursively", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-storage-"));
    try {
      const nested = join(home, "a", "b");
      await nodeSessionStorage.ensureDirectory(nested);
      await nodeSessionStorage.appendLine(join(nested, "events.jsonl"), "{}\n");
      expect(await readdir(nested)).toEqual(["events.jsonl"]);
      await nodeSessionStorage.removeDirectory(join(home, "a"));
      expect(await nodeSessionStorage.listDirectories(home)).toEqual([]);
      // 重复删除必须幂等。
      await nodeSessionStorage.removeDirectory(join(home, "a"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails cleanly when the atomic meta target directory is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-storage-"));
    try {
      await mkdir(join(home, "exists"), { recursive: true });
      const target = join(home, "missing", "meta.json");
      expect(nodeSessionStorage.writeFileAtomic(target, "{}\n")).rejects.toThrow();
      // 失败后不得留下临时文件。
      expect(await readdir(join(home, "exists"))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
