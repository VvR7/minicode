import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkLock } from "./lock.ts";

describe("BenchmarkLock", () => {
  test("rejects a concurrent runner and releases only the owner lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-lock-test-"));
    const first = new BenchmarkLock(root);
    const second = new BenchmarkLock(root);
    try {
      await first.acquire();
      expect(await first.heldByLiveProcess()).toBe(true);
      await expect(second.acquire()).rejects.toThrow("another SWE-bench runner");
      await first.release();
      await second.acquire();
      await second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
