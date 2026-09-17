import { describe, expect, test } from "bun:test";
import {
  Compactor,
  prepareCompaction,
  toProviderMessages,
  applyCompaction,
} from "../../src/compact/compactor.ts";
import type { ContextEntry, CompactionCheckpoint } from "../../src/compact/types.ts";
import { ContextEntrySchema, CompactionCheckpointSchema } from "../../src/compact/types.ts";
import { FakeProvider, textResponse, RUN_A, RUN_B, usage } from "../agent/test-helpers.ts";
import { LlmError } from "../../src/llm/errors.ts";
const config = { enabled: true, reserveTokens: 100, keepRecentTokens: 20 };
const signal = new AbortController().signal;
function entry(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
  runId = RUN_A,
): ContextEntry {
  return { messageId: id, role, runId, content: [{ type: "text", text }] };
}
const options = (entries: readonly ContextEntry[]) => ({
  entries,
  reason: "manual" as const,
  tokensBefore: 500,
  signal,
});
const checkpoint: CompactionCheckpoint = {
  compactionId: "550e8400-e29b-41d4-a716-446655440555",
  kind: "summary",
  firstKeptMessageId: "u1",
  tokensBefore: 500,
  tokensAfter: 30,
  reason: "manual",
  summary: "OLD GOAL",
  readFiles: ["old.ts"],
  modifiedFiles: [],
  usage: usage(),
};
describe("compaction preparation", () => {
  test("no-op when there is no older range", () => {
    expect(prepareCompaction([], 20)).toBeUndefined();
    expect(prepareCompaction([entry("u", "short")], 20000)).toBeUndefined();
  });
  test("tool results stay paired and run prefix is separate", () => {
    const entries: ContextEntry[] = [
      entry("old", "old", "user", RUN_B),
      entry("u1", "latest request"),
      {
        ...entry("a1", "", "assistant"),
        content: [{ type: "tool_use", id: "t", name: "read", input: { path: "new.ts" } }],
      },
      {
        ...entry("t1", ""),
        content: [{ type: "tool_result", toolUseId: "t", content: "x".repeat(1000) }],
      },
    ];
    const prepared = prepareCompaction(entries, 20);
    expect(prepared?.kept.map((entry) => entry.messageId)).toEqual(["a1", "t1"]);
    expect(prepared?.history.map((entry) => entry.messageId)).toEqual(["old"]);
    expect(prepared?.prefix.map((entry) => entry.messageId)).toEqual(["u1"]);
  });
  test("strict metadata rejects invalid entries/checkpoints", () => {
    expect(
      ContextEntrySchema.safeParse({
        ...entry("u", "x"),
        metadata: { kind: "other", compactionId: checkpoint.compactionId },
      }).success,
    ).toBe(false);
    expect(CompactionCheckpointSchema.safeParse({ ...checkpoint, summary: "" }).success).toBe(
      false,
    );
  });
});
describe("compaction generation", () => {
  test("incremental history preserves the previous goal and file lists", async () => {
    const provider = new FakeProvider([
      { response: textResponse("UPDATED", { usage: usage({ inputTokens: 4, outputTokens: 3 }) }) },
    ]);
    const visible = applyCompaction(checkpoint, [
      entry("u1", "older request"),
      {
        ...entry("a1", "", "assistant"),
        content: [
          { type: "tool_use", id: "t", name: "write", input: { path: "changed.ts", content: "x" } },
        ],
      },
      entry("u2", "recent".repeat(100), "user", RUN_B),
    ]);
    const result = await new Compactor(provider, config, 500).compact({
      ...options(visible),
      focus: "tests",
      previous: checkpoint,
    });
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain("OLD GOAL");
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain("Additional focus: tests");
    expect(provider.calls[0]?.options).toMatchObject({
      maxAttempts: 1,
      maxOutputTokens: 80,
      toolSchemas: [],
    });
    expect(result?.checkpoint).toMatchObject({
      kind: "summary",
      readFiles: ["old.ts"],
      modifiedFiles: ["changed.ts"],
      usage: usage({ inputTokens: 4, outputTokens: 3 }),
    });
    expect(result?.entries[1]?.messageId).toBe("u2");
    expect(toProviderMessages(result?.entries ?? [])[0]).not.toHaveProperty("metadata");
  });
  test("prefix-only compaction retains the old summary and forwards focus", async () => {
    const provider = new FakeProvider([{ response: textResponse("PREFIX") }]);
    const visible = applyCompaction(checkpoint, [
      entry("u1", "latest intent"),
      entry("a1", "recent".repeat(100), "assistant"),
    ]);
    const result = await new Compactor(provider, config, 500).compact({
      ...options(visible),
      focus: "errors",
      previous: checkpoint,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.options?.maxOutputTokens).toBe(50);
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain("Additional focus: errors");
    expect(result?.checkpoint.summary).toContain("OLD GOAL");
    expect(result?.checkpoint.summary).toContain("PREFIX");
  });
  test("split run uses two independent requests and combines usage", async () => {
    const provider = new FakeProvider([
      { response: textResponse("HISTORY", { usage: usage({ inputTokens: 10 }) }) },
      { response: textResponse("PREFIX", { usage: usage({ inputTokens: 20 }) }) },
    ]);
    const result = await new Compactor(provider, config, 500).compact(
      options([
        entry("old", "history", "user", RUN_B),
        entry("u1", "latest intent"),
        entry("a1", "recent".repeat(100), "assistant"),
      ]),
    );
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(provider.calls[0]?.messages)).not.toContain("latest intent");
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain("latest intent");
    expect(result?.checkpoint.usage.inputTokens).toBe(30);
  });
  test("non-context failure retries once; repeated invalid summaries fail without mutation", async () => {
    const entries = [entry("old", "old", "user", RUN_B), entry("u", "recent".repeat(100))];
    const saved = JSON.stringify(entries);
    const provider = new FakeProvider([
      { error: new LlmError("network_error", "drop") },
      { response: textResponse("OK") },
    ]);
    expect(
      (await new Compactor(provider, config, 500).compact(options(entries)))?.checkpoint.kind,
    ).toBe("summary");
    expect(provider.calls).toHaveLength(2);
    const failed = new FakeProvider([
      { response: textResponse("partial", { finishReason: "max_tokens" }) },
      { response: textResponse("") },
    ]);
    await expect(new Compactor(failed, config, 500).compact(options(entries))).rejects.toThrow();
    expect(failed.calls).toHaveLength(2);
    expect(JSON.stringify(entries)).toBe(saved);
  });
  test("summary overflow immediately produces explicit fallback with previous summary and user intent", async () => {
    const provider = new FakeProvider([
      { error: new LlmError("context_limit_exceeded", "too long") },
    ]);
    const visible = applyCompaction(checkpoint, [
      entry("u1", "latest intent"),
      entry("a1", "recent".repeat(100), "assistant"),
    ]);
    const result = await new Compactor(provider, config, 500).compact({
      ...options(visible),
      previous: checkpoint,
    });
    expect(provider.calls).toHaveLength(1);
    expect(result?.checkpoint.kind).toBe("fallback");
    expect(result?.checkpoint.summary).toContain("hidden without successful summarization");
    expect(result?.checkpoint.summary).toContain("OLD GOAL");
    expect(result?.checkpoint.summary).toContain("latest intent");
    expect(result?.entries[0]?.metadata?.kind).toBe("fallback");
  });
  test("cancelled summaries are neither retried nor committed", async () => {
    const provider = new FakeProvider([{ error: new LlmError("aborted", "cancelled") }]);
    await expect(
      new Compactor(provider, config, 500).compact(
        options([entry("old", "old", "user", RUN_B), entry("u", "recent".repeat(100))]),
      ),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new Compactor(provider, config, 500).compact({ ...options([]), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
