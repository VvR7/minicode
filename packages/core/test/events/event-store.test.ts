import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@minicode/protocol";
import { EventStore } from "../../src/events/event-store.ts";
import { MemoryJournalStorage, RUN_A, SESSION_A, sequencedStarted } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "minicode-event-store-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("EventStore", () => {
  test("writes isolated JSONL with private directory and file permissions", async () => {
    const home = await temporaryDirectory();
    const store = new EventStore(home);
    const event = sequencedStarted();

    expect(await store.append(event)).toEqual({ ok: true, value: undefined });
    const path = store.pathFor(SESSION_A, RUN_A);
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual(event);
    for (const directory of [
      home,
      join(home, "sessions"),
      join(home, "sessions", SESSION_A),
      join(home, "sessions", SESSION_A, "runs"),
      join(path, ".."),
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("replays events after an exclusive sequence cursor", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);
    await store.append(sequencedStarted(1));
    await store.appendWatermark(SESSION_A, RUN_A, 2);
    await store.append({ ...sequencedStarted(3), type: "step.started", payload: { step: 1 } });

    const replay = await store.read(SESSION_A, RUN_A, 1);
    expect(replay.ok && replay.value.events.map((event) => event.sequence)).toEqual([3]);
    expect(replay.ok && replay.value.latestSequence).toBe(3);
  });

  test("stores transient sequence watermarks without transient payloads", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);

    expect(await store.appendWatermark(SESSION_A, RUN_A, 1)).toEqual({
      ok: true,
      value: undefined,
    });
    const journal = storage.files.get(store.pathFor(SESSION_A, RUN_A)) ?? "";
    expect(journal).toContain('"kind":"sequence.watermark"');
    expect(journal).not.toContain("secret delta");
    expect(await store.read(SESSION_A, RUN_A)).toEqual({
      ok: true,
      value: { events: [], latestSequence: 1, finished: false },
    });
  });

  test("rejects non-durable or non-schema data instead of persisting secrets", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);
    const unsafe = {
      ...sequencedStarted(),
      goal: "secret goal",
      workspaceRoot: "/secret/workspace",
    } as unknown as AgentEvent;

    expect(await store.append(unsafe)).toEqual({
      ok: false,
      error: { code: "invalid_event", message: "only valid durable events can be persisted" },
    });
    expect(storage.files.size).toBe(0);
  });

  test("returns typed failures for storage errors and corrupt journals", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);
    storage.appendError = new Error("private write detail");
    expect(await store.append(sequencedStarted())).toEqual({
      ok: false,
      error: { code: "write_failed", message: "failed to persist agent event" },
    });

    storage.appendError = undefined;
    storage.readError = new Error("private read detail");
    expect(await store.read(SESSION_A, RUN_A)).toEqual({
      ok: false,
      error: { code: "read_failed", message: "failed to read agent event journal" },
    });

    storage.readError = undefined;
    storage.files.set(store.pathFor(SESSION_A, RUN_A), "not-json\n");
    expect(await store.read(SESSION_A, RUN_A)).toEqual({
      ok: false,
      error: { code: "corrupt_journal", message: "agent event journal is corrupt" },
    });
  });

  test("treats duplicate or foreign run sequences as corrupt", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);
    const line = JSON.stringify(sequencedStarted());
    storage.files.set(store.pathFor(SESSION_A, RUN_A), `${line}\n${line}\n`);
    expect((await store.read(SESSION_A, RUN_A)).ok).toBe(false);

    storage.files.set(
      store.pathFor(SESSION_A, RUN_A),
      `${JSON.stringify({ ...sequencedStarted(), runId: "6ba7b810-9dad-41d1-80b4-00c04fd430c9" })}\n`,
    );
    expect((await store.read(SESSION_A, RUN_A)).ok).toBe(false);
  });

  test("rejects unsafe identities and cursors before touching storage paths", async () => {
    const storage = new MemoryJournalStorage();
    const store = new EventStore("/memory", storage);

    expect(await store.read("../../escape", RUN_A)).toEqual({
      ok: false,
      error: { code: "invalid_event", message: "event journal identity or cursor is invalid" },
    });
    expect(await store.read(SESSION_A, RUN_A, -1)).toEqual({
      ok: false,
      error: { code: "invalid_event", message: "event journal identity or cursor is invalid" },
    });
    expect(storage.files.size).toBe(0);
  });
});
