import { describe, expect, test } from "bun:test";
import { buildContextEntries } from "../../src/session/session-store.ts";
import {
  createMemoryStore,
  TURN_A,
  TURN_B,
  RUN_A,
  RUN_B,
  CLIENT_MESSAGE_A,
  CLIENT_MESSAGE_B,
} from "../session/test-helpers.ts";
import type { HistoryMessage, RunId, TurnId } from "@minicode/protocol";
import type { CompactionCheckpoint } from "../../src/compact/types.ts";
import { usage } from "../agent/test-helpers.ts";
function messages(turnId: TurnId, runId: RunId, prefix: string): HistoryMessage[] {
  return ["user", "assistant"].map((role, i) => ({
    messageId: `${prefix}-${i}`,
    turnId,
    runId,
    role: role === "user" ? "user" : "assistant",
    timestamp: "2026-09-17T00:00:00Z",
    content: [{ type: "text", text: `${prefix}-${i}` }],
  }));
}
function cp(
  firstKeptMessageId: string,
  kind: "summary" | "fallback" = "summary",
): CompactionCheckpoint {
  return {
    compactionId: crypto.randomUUID(),
    kind,
    firstKeptMessageId,
    tokensBefore: 500,
    tokensAfter: 40,
    reason: "manual",
    summary: kind === "summary" ? "checkpoint" : "earlier history hidden",
    readFiles: [],
    modifiedFiles: [],
    usage: usage(),
  };
}
function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("expected success");
  return result.value;
}
describe("checkpoint journal recovery", () => {
  test("preserves originals and resumes from the latest manual compact", async () => {
    const { store, storage } = createMemoryStore();
    const session = unwrap(await store.create({ workspaceRoot: "/project", mode: "chat" }));
    const id = session.meta.sessionId;
    unwrap(
      await store.appendAccepted(id, {
        turnId: TURN_A,
        runId: RUN_A,
        clientMessageId: CLIENT_MESSAGE_A,
        userMessage: "a",
      }),
    );
    unwrap(
      await store.appendCompleted(id, {
        turnId: TURN_A,
        runId: RUN_A,
        status: "succeeded",
        model: "fake",
        messages: messages(TURN_A, RUN_A, "a"),
      }),
    );
    unwrap(
      await store.appendAccepted(id, {
        turnId: TURN_B,
        runId: RUN_B,
        clientMessageId: CLIENT_MESSAGE_B,
        userMessage: "b",
      }),
    );
    unwrap(
      await store.appendCompleted(id, {
        turnId: TURN_B,
        runId: RUN_B,
        status: "succeeded",
        model: "fake",
        messages: messages(TURN_B, RUN_B, "b"),
      }),
    );
    const before = storage.files.get(`/home/sessions/${id}/history.jsonl`) ?? "";
    unwrap(await store.appendCompaction(id, cp("a-1")));
    const fallback = cp("b-0", "fallback");
    unwrap(await store.appendCompaction(id, fallback));
    const restored = unwrap(await store.load(id));
    expect(restored.turns.flatMap((turn) => turn.messages)).toHaveLength(4);
    expect(storage.files.get(`/home/sessions/${id}/history.jsonl`)?.startsWith(before)).toBe(true);
    expect(
      buildContextEntries(restored.turns, restored.compactions).map((entry) => entry.messageId),
    ).toEqual([fallback.compactionId, "b-0", "b-1"]);
    expect((await store.appendCompaction(id, fallback)).ok).toBe(false);
    expect((await store.appendCompaction(id, cp("missing"))).ok).toBe(false);
    storage.appendError = new Error("disk");
    expect((await store.appendCompaction(id, cp("b-1"))).ok).toBe(false);
    expect(unwrap(await store.load(id)).compactions).toHaveLength(2);
  });
  test("run checkpoints are ignored until successful completion and excluded after failure", async () => {
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      const { store } = createMemoryStore();
      const id = unwrap(await store.create({ workspaceRoot: "/project", mode: "chat" })).meta
        .sessionId;
      unwrap(
        await store.appendAccepted(id, {
          turnId: TURN_A,
          runId: RUN_A,
          clientMessageId: CLIENT_MESSAGE_A,
          userMessage: "a",
        }),
      );
      const checkpoint = cp("a-1");
      unwrap(await store.appendCompaction(id, checkpoint, RUN_A));
      const pending = unwrap(await store.load(id));
      expect(buildContextEntries(pending.turns, pending.compactions)).toEqual([]);
      unwrap(
        await store.appendCompleted(id, {
          turnId: TURN_A,
          runId: RUN_A,
          status,
          model: "fake",
          messages: messages(TURN_A, RUN_A, "a"),
        }),
      );
      const completed = unwrap(await store.load(id));
      const entries = buildContextEntries(completed.turns, completed.compactions);
      expect(entries.map((entry) => entry.messageId)).toEqual(
        status === "succeeded" ? [checkpoint.compactionId, "a-1"] : [],
      );
    }
  });
});
