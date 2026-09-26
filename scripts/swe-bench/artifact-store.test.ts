import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifact-store.ts";
import { SecretRedactor } from "./redactor.ts";

describe("ArtifactStore credential scrubbing", () => {
  test("never persists an injected secret in text or JSON artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-artifact-test-"));
    const secret = "sk-injected-real-value";
    try {
      const store = new ArtifactStore(root, new SecretRedactor([secret]));
      await store.initialize();
      await store.writeTaskText("task", "agent.stdout.log", `stdout ${secret}`);
      await store.writeTaskJson("task", "result.json", { error: secret });
      await store.writeRunState({
        schemaVersion: 1,
        runId: "run",
        pid: 1,
        taskId: secret,
        updatedAt: new Date(0).toISOString(),
      });
      await store.writeSummary({ detail: secret });
      await store.writeRootText("summary.md", secret);

      for (const relative of await readdir(root, { recursive: true })) {
        const path = join(root, relative);
        if ((await stat(path)).isDirectory()) continue;
        expect(await readFile(path, "utf8")).not.toContain(secret);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
