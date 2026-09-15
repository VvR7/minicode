import { describe, expect, test } from "bun:test";
import type { RunId, SessionId } from "@minicode/protocol";
import { NoteStore } from "../../src/session/notes.ts";
import { MAX_NOTE_CHARS, MAX_NOTES_BYTES } from "../../src/session/types.ts";
import { MemorySessionStorage, RUN_A, SESSION_A } from "./test-helpers.ts";

function makeNoteStore(storage: MemorySessionStorage, path = "/home/notes.md"): NoteStore {
  return new NoteStore(
    storage,
    path,
    { sessionId: SESSION_A, runId: RUN_A },
    () => "2026-09-14T08:00:00.000Z",
  );
}

describe("NoteStore", () => {
  test("appends a fixed-format record with timestamp, session, run, and body", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    const result = await notes.append("  remember the workspace layout  ");
    expect(result.ok).toBe(true);

    const content = storage.files.get("/home/notes.md") ?? "";
    expect(content).toBe(
      `### 2026-09-14T08:00:00.000Z\nschemaVersion: 1\nsessionId: ${SESSION_A}\nrunId: ${RUN_A}\n\nremember the workspace layout\n\n`,
    );
    const read = await notes.read();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe(content);
    }
  });

  test("rejects empty and oversized single notes without writing", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    const empty = await notes.append("   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("note_invalid");
    }
    const oversized = await notes.append("x".repeat(MAX_NOTE_CHARS + 1));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe("note_invalid");
    }
    expect(storage.files.get("/home/notes.md")).toBeUndefined();
  });

  test("accepts exactly the single-note character limit", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    const result = await notes.append("x".repeat(MAX_NOTE_CHARS));
    expect(result.ok).toBe(true);
  });

  test("stops at the total size limit without truncating existing notes", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    const chunk = "你".repeat(MAX_NOTE_CHARS);
    let failure: string | undefined;
    for (let index = 0; index < 10; index += 1) {
      const result = await notes.append(chunk);
      if (!result.ok) {
        failure = result.error.code;
        break;
      }
    }
    expect(failure).toBe("note_limit_exceeded");
    const content = storage.files.get("/home/notes.md") ?? "";
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(MAX_NOTES_BYTES);
    // 失败时未写入半条 note，最后仍是完整的 ### 记录头。
    expect(content.endsWith("\n\n")).toBe(true);
  });

  test("surfaces read and write failures as structured errors", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    storage.readError = new Error("boom");
    const read = await notes.read();
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("io_error");
    }
    storage.readError = undefined;
    storage.appendError = new Error("boom");
    const write = await notes.append("hello");
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.error.code).toBe("io_error");
    }
  });

  test("rejects malformed, unknown-version, and oversized persisted notes", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    storage.files.set("/home/notes.md", "not a note\n");
    expect((await notes.read()).ok).toBe(false);

    storage.files.set(
      "/home/notes.md",
      notes.render("valid").replace("schemaVersion: 1", "schemaVersion: 2"),
    );
    expect((await notes.read()).ok).toBe(false);

    storage.files.set("/home/notes.md", "x".repeat(MAX_NOTES_BYTES + 1));
    expect((await notes.read()).ok).toBe(false);

    storage.files.set(
      "/home/notes.md",
      notes.render("foreign").replace(SESSION_A, "550e8400-e29b-41d4-a716-446655440199"),
    );
    expect((await notes.read()).ok).toBe(false);
  });

  test("serializes appends across NoteStore instances before checking the total limit", async () => {
    const storage = new MemorySessionStorage();
    const first = makeNoteStore(storage);
    const second = makeNoteStore(storage);
    storage.files.set("/home/notes.md", first.render("x".repeat(MAX_NOTE_CHARS)).repeat(15));

    const results = await Promise.all([
      first.append("a".repeat(8_000)),
      second.append("b".repeat(8_000)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(encoderSize(storage.files.get("/home/notes.md") ?? "")).toBeLessThanOrEqual(
      MAX_NOTES_BYTES,
    );
  });

  test("reports the current notes byte size", async () => {
    const storage = new MemorySessionStorage();
    const notes = makeNoteStore(storage);
    await notes.append("hello");
    const size = await notes.sizeBytes();
    expect(size.ok).toBe(true);
    if (size.ok) {
      expect(size.value).toBeGreaterThan(0);
    }
  });

  test("does not inject notes written during the current run into that run", async () => {
    const storage = new MemorySessionStorage();
    const firstRun = new NoteStore(
      storage,
      "/home/notes.md",
      { sessionId: SESSION_A, runId: RUN_A },
      () => "2026-09-14T08:00:00.000Z",
    );
    // run 开始时读取到的快照为空，之后该 run 写入的 note 不属于本次注入。
    const snapshotAtRunStart = await firstRun.read();
    expect(snapshotAtRunStart.ok).toBe(true);
    if (snapshotAtRunStart.ok) {
      expect(snapshotAtRunStart.value).toBe("");
    }
    await firstRun.append("new fact");
    // 下一轮重建 system prompt 时会读到这条 note。
    const nextRun = new NoteStore(
      storage,
      "/home/notes.md",
      { sessionId: SESSION_A, runId: "6ba7b810-9dad-41d1-80b4-00c04fd430a9" as RunId },
      () => "2026-09-14T08:01:00.000Z",
    );
    const nextSnapshot = await nextRun.read();
    expect(nextSnapshot.ok).toBe(true);
    if (nextSnapshot.ok) {
      expect(nextSnapshot.value).toContain("new fact");
    }
  });

  test("scopes notes to the owning session identity", async () => {
    const storage = new MemorySessionStorage();
    const other = new NoteStore(
      storage,
      "/home/other.md",
      { sessionId: "550e8400-e29b-41d4-a716-446655440199" as SessionId, runId: RUN_A },
      () => "2026-09-14T08:00:00.000Z",
    );
    await other.append("other session note");
    const notes = makeNoteStore(storage);
    const read = await notes.read();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe("");
    }
  });
});

function encoderSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
