import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryMessage, SessionEvent, SessionId } from "@minicode/protocol";
import {
  buildContextMessages,
  deriveTitle,
  MAX_TITLE_CODE_POINTS,
  NEW_SESSION_TITLE,
  SessionStore,
} from "../../src/session/session-store.ts";
import { nodeSessionStorage } from "../../src/session/storage.ts";
import {
  CLIENT_MESSAGE_A,
  CLIENT_MESSAGE_B,
  CLIENT_MESSAGE_C,
  createMemoryStore,
  type MemorySessionStorage,
  RUN_A,
  RUN_B,
  RUN_C,
  SESSION_A,
  SESSION_B,
  seedSession,
  sessionPaths,
  TURN_A,
  TURN_B,
  TURN_C,
} from "./test-helpers.ts";

const HOME = "/home";

function userMessage(text: string, turnId = TURN_A, runId = RUN_A): HistoryMessage {
  return {
    messageId: crypto.randomUUID(),
    turnId,
    runId,
    role: "user",
    timestamp: "2026-09-14T08:00:10.000Z",
    content: [{ type: "text", text }],
  };
}

function assistantMessage(text: string, turnId = TURN_A, runId = RUN_A): HistoryMessage {
  return {
    messageId: crypto.randomUUID(),
    turnId,
    runId,
    role: "assistant",
    timestamp: "2026-09-14T08:00:11.000Z",
    content: [{ type: "text", text }],
  };
}

function toolPair(): HistoryMessage[] {
  return [
    {
      messageId: crypto.randomUUID(),
      turnId: TURN_A,
      runId: RUN_A,
      role: "assistant",
      timestamp: "2026-09-14T08:00:10.500Z",
      content: [
        { type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
      ],
    },
    {
      messageId: crypto.randomUUID(),
      turnId: TURN_A,
      runId: RUN_A,
      role: "user",
      timestamp: "2026-09-14T08:00:10.750Z",
      content: [{ type: "tool_result", toolUseId: "call-1", content: "alpha" }],
    },
  ];
}

function acceptedEvent(sequence: number): SessionEvent {
  return {
    sessionId: SESSION_A,
    sessionSequence: sequence,
    timestamp: "2026-09-14T08:01:00.000Z",
    durable: true,
    type: "session.turn_accepted",
    payload: {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    },
  };
}

function finishedEvent(sequence: number): SessionEvent {
  return {
    sessionId: SESSION_A,
    sessionSequence: sequence,
    timestamp: "2026-09-14T08:02:00.000Z",
    durable: true,
    type: "session.turn_finished",
    payload: { turnId: TURN_A, runId: RUN_A, status: "succeeded", reason: "completed" },
  };
}

describe("SessionStore create and load", () => {
  test("creates a versioned session with private layout and empty journals", async () => {
    const { store, storage } = createMemoryStore(HOME);
    const created = await store.create({ mode: "chat", workspaceRoot: "/workspace" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.value.meta.title).toBe(NEW_SESSION_TITLE);
    expect(created.value.status).toBe("idle");
    expect(created.value.turns).toEqual([]);
    expect(created.value.pendingInterruptions).toEqual([]);

    const loaded = await store.load(created.value.meta.sessionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.meta.schemaVersion).toBe(1);
      expect(loaded.value.meta.mode).toBe("chat");
      expect(loaded.value.notes).toBe("");
    }
    const paths = sessionPaths(HOME, created.value.meta.sessionId);
    expect(storage.files.get(paths.history)).toBe("");
    expect(storage.files.get(paths.sessionEvents)).toBe("");
    expect(storage.files.get(paths.notes)).toBe("");
  });

  test("returns session_not_found for a missing session", async () => {
    const { store } = createMemoryStore(HOME);
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("session_not_found");
    }
  });

  test("treats an unknown meta schemaVersion as corrupted", async () => {
    const { store, storage } = createMemoryStore(HOME);
    const meta = seedSession(storage, HOME, SESSION_A);
    storage.files.set(
      sessionPaths(HOME, SESSION_A).meta,
      JSON.stringify({ ...meta, schemaVersion: 99 }),
    );
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("session_corrupted");
    }
  });

  test("rejects meta whose identity does not match its directory", async () => {
    const { store, storage } = createMemoryStore(HOME);
    const meta = seedSession(storage, HOME, SESSION_A);
    storage.files.set(
      sessionPaths(HOME, SESSION_A).meta,
      JSON.stringify({ ...meta, sessionId: SESSION_B }),
    );
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("session_corrupted");
    }
  });

  test("surfaces io failures for meta reads", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    storage.readError = new Error("boom");
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("io_error");
    }
  });

  test("exposes a run-scoped NoteStore bound to the session notes file", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const notes = store.createNoteStore(SESSION_A, RUN_A);
    const appended = await notes.append("remember this");
    expect(appended.ok).toBe(true);
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.notes).toContain("remember this");
      expect(loaded.value.notes).toContain(RUN_A);
    }
    expect(storage.files.get(sessionPaths(HOME, SESSION_A).notes)).toContain("remember this");
  });
});

describe("SessionStore turn lifecycle", () => {
  test("derives the title from the first accepted message and caps it", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const accepted = await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "\n\n  first line  \nsecond line",
    });
    expect(accepted.ok).toBe(true);
    const first = await store.load(SESSION_A);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.meta.title).toBe("first line");
    }

    // 另一个 session 验证超长标题按 code point 截断。
    seedSession(storage, HOME, SESSION_B);
    const longText = "x".repeat(MAX_TITLE_CODE_POINTS + 40);
    const cappedResult = await store.appendAccepted(SESSION_B, {
      turnId: TURN_C,
      runId: RUN_C,
      clientMessageId: CLIENT_MESSAGE_C,
      userMessage: longText,
    });
    expect(cappedResult.ok).toBe(true);
    const capped = await store.load(SESSION_B);
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect([...capped.value.meta.title].length).toBe(MAX_TITLE_CODE_POINTS);
    }
  });

  test("keeps a running turn with pending interruption until completion arrives", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "first line",
    });
    const running = await store.load(SESSION_A);
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    expect(running.value.status).toBe("running");
    expect(running.value.activeRun).toEqual({ turnId: TURN_A, runId: RUN_A });
    expect(running.value.pendingInterruptions).toHaveLength(1);
    expect(running.value.turns[0]?.status).toBe("running");
    expect(running.value.meta.title).toBe("first line");

    const completed = await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      reason: "completed",
      messages: [userMessage("first line"), assistantMessage("done")],
      model: "test-model",
    });
    expect(completed.ok).toBe(true);
    const idle = await store.load(SESSION_A);
    expect(idle.ok).toBe(true);
    if (idle.ok) {
      expect(idle.value.status).toBe("idle");
      expect(idle.value.activeRun).toBeUndefined();
      expect(idle.value.pendingInterruptions).toEqual([]);
      expect(idle.value.turns[0]?.status).toBe("succeeded");
      expect(idle.value.turns[0]?.includedInContext).toBe(true);
    }
  });

  test("marks only succeeded completions as included in context", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const statuses = [
      { turnId: TURN_A, runId: RUN_A, clientMessageId: CLIENT_MESSAGE_A, status: "failed" },
      { turnId: TURN_B, runId: RUN_B, clientMessageId: CLIENT_MESSAGE_B, status: "cancelled" },
      { turnId: TURN_C, runId: RUN_C, clientMessageId: CLIENT_MESSAGE_C, status: "interrupted" },
    ] as const;
    for (const entry of statuses) {
      await store.appendAccepted(SESSION_A, {
        turnId: entry.turnId,
        runId: entry.runId,
        clientMessageId: entry.clientMessageId,
        userMessage: `msg-${entry.status}`,
      });
      const completed = await store.appendCompleted(SESSION_A, {
        turnId: entry.turnId,
        runId: entry.runId,
        status: entry.status,
        messages: [userMessage(`msg-${entry.status}`, entry.turnId, entry.runId)],
        model: "test-model",
      });
      expect(completed.ok).toBe(true);
    }
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.turns.map((turn) => turn.includedInContext)).toEqual([false, false, false]);
    expect(buildContextMessages(loaded.value.turns)).toEqual([]);
  });

  test("is idempotent per clientMessageId and rejects content conflicts", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const first = await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    const retry = await store.appendAccepted(SESSION_A, {
      turnId: TURN_B,
      runId: RUN_B,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.value.idempotent).toBe(true);
      expect(retry.value.turnId).toBe(first.value.turnId);
      expect(retry.value.runId).toBe(first.value.runId);
    }

    const conflicting = await store.appendAccepted(SESSION_A, {
      turnId: TURN_C,
      runId: RUN_C,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "different",
    });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toBe("idempotency_conflict");
    }

    const history = storage.files.get(sessionPaths(HOME, SESSION_A).history) ?? "";
    expect(history.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
  });

  test("rejects duplicate turn identities and unknown completions", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    const duplicate = await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_B,
      userMessage: "hello again",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("duplicate_turn");
    }

    const unknown = await store.appendCompleted(SESSION_A, {
      turnId: TURN_B,
      runId: RUN_B,
      status: "succeeded",
      messages: [userMessage("nope")],
      model: "m",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("unknown_turn");
    }
  });

  test("rejects a second completion for the same turn", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      messages: [userMessage("hello")],
      model: "m",
    });
    const again = await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      messages: [userMessage("hello")],
      model: "m",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("duplicate_turn");
    }
  });

  test("rejects an invalid completion without poisoning the history journal", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    const path = sessionPaths(HOME, SESSION_A).history;
    const before = storage.files.get(path);
    const invalid = await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      messages: [],
      model: "",
    });
    expect(invalid.ok).toBe(false);
    expect(storage.files.get(path)).toBe(before);

    const foreignMessage = await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      messages: [userMessage("hello", TURN_B, RUN_B)],
      model: "model",
    });
    expect(foreignMessage.ok).toBe(false);
    expect(storage.files.get(path)).toBe(before);
  });

  test("rejects invalid turn input and reports storage failures", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const invalid = await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid_input");
    }

    storage.appendError = new Error("disk");
    const failed = await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("io_error");
    }
  });

  test("serializes concurrent appends for one session without losing records", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await Promise.all([
      store.appendAccepted(SESSION_A, {
        turnId: TURN_A,
        runId: RUN_A,
        clientMessageId: CLIENT_MESSAGE_A,
        userMessage: "a",
      }),
      store.appendAccepted(SESSION_A, {
        turnId: TURN_B,
        runId: RUN_B,
        clientMessageId: CLIENT_MESSAGE_B,
        userMessage: "b",
      }),
    ]);
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.turns).toHaveLength(2);
    }
  });
});

describe("SessionStore session events", () => {
  test("appends contiguous events and replays after a cursor", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    expect((await store.appendSessionEvent(SESSION_A, acceptedEvent(1))).ok).toBe(true);
    await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      reason: "completed",
      messages: [userMessage("hello"), assistantMessage("done")],
      model: "test-model",
    });
    expect((await store.appendSessionEvent(SESSION_A, finishedEvent(2))).ok).toBe(true);

    const replay = await store.readSessionEvents(SESSION_A, 1);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.map((event) => event.sessionSequence)).toEqual([2]);
    }
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.latestSessionSequence).toBe(2);
    }
  });

  test("rejects sequence gaps and foreign scopes", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const gap = await store.appendSessionEvent(SESSION_A, finishedEvent(2));
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.error.code).toBe("invalid_input");
    }
    const foreign = await store.appendSessionEvent(SESSION_A, {
      ...acceptedEvent(1),
      sessionId: SESSION_B,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe("invalid_input");
    }
  });
});

describe("SessionStore corruption detection", () => {
  test("marks missing fixed journals or notes as corrupt", async () => {
    for (const name of ["history", "sessionEvents", "notes"] as const) {
      const { store, storage } = createMemoryStore(HOME);
      seedSession(storage, HOME, SESSION_A);
      storage.files.delete(sessionPaths(HOME, SESSION_A)[name]);
      const loaded = await store.load(SESSION_A);
      expect([name, loaded.ok]).toEqual([name, false]);
    }
  });

  test("marks duplicate client IDs with changed identity or content as corrupt", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const base = {
      schemaVersion: 1,
      recordId: crypto.randomUUID(),
      sessionId: SESSION_A,
      turnId: TURN_A,
      runId: RUN_A,
      timestamp: "2026-09-14T08:00:00.000Z",
      kind: "turn.accepted",
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "one",
    };
    storage.files.set(
      sessionPaths(HOME, SESSION_A).history,
      `${JSON.stringify(base)}\n${JSON.stringify({
        ...base,
        recordId: crypto.randomUUID(),
        runId: RUN_B,
        userMessage: "two",
      })}\n`,
    );
    expect((await store.load(SESSION_A)).ok).toBe(false);
  });

  test("marks duplicate event IDs and event/history identity mismatches as corrupt", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    const recordId = crypto.randomUUID();
    const first = { schemaVersion: 1, recordId, event: acceptedEvent(1) };
    const second = {
      schemaVersion: 1,
      recordId,
      event: {
        ...acceptedEvent(2),
        payload: { ...acceptedEvent(2).payload, userMessage: "other" },
      },
    };
    storage.files.set(
      sessionPaths(HOME, SESSION_A).sessionEvents,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );
    expect((await store.load(SESSION_A)).ok).toBe(false);

    storage.files.set(
      sessionPaths(HOME, SESSION_A).sessionEvents,
      `${JSON.stringify({ ...second, recordId: crypto.randomUUID(), event: second.event })}\n`,
    );
    expect((await store.load(SESSION_A)).ok).toBe(false);
  });

  test("marks tail truncation, bad lines, foreign identities, and sequence gaps corrupt", async () => {
    const cases: { name: string; mutate: (storage: MemorySessionStorage) => void }[] = [
      {
        name: "incomplete final line",
        mutate: (storage) => storage.files.set(sessionPaths(HOME, SESSION_A).history, '{"bad":1}'),
      },
      {
        name: "unparseable middle line",
        mutate: (storage) => storage.files.set(sessionPaths(HOME, SESSION_A).history, "not-json\n"),
      },
      {
        name: "blank middle line",
        mutate: (storage) => storage.files.set(sessionPaths(HOME, SESSION_A).history, "\n\n"),
      },
      {
        name: "missing trailing newline after valid record",
        mutate: (storage) =>
          storage.files.set(
            sessionPaths(HOME, SESSION_A).history,
            `${JSON.stringify({
              schemaVersion: 1,
              recordId: crypto.randomUUID(),
              sessionId: SESSION_B,
              turnId: TURN_A,
              runId: RUN_A,
              timestamp: "2026-09-14T08:00:00.000Z",
              kind: "turn.accepted",
              clientMessageId: CLIENT_MESSAGE_A,
              userMessage: "x",
            })}\n{"partial":`,
          ),
      },
      {
        name: "session event sequence gap",
        mutate: (storage) =>
          storage.files.set(
            sessionPaths(HOME, SESSION_A).sessionEvents,
            `${JSON.stringify({
              schemaVersion: 1,
              recordId: crypto.randomUUID(),
              event: { ...finishedEvent(3) },
            })}\n`,
          ),
      },
    ];

    for (const testCase of cases) {
      const { store, storage } = createMemoryStore(HOME);
      seedSession(storage, HOME, SESSION_A);
      testCase.mutate(storage);
      const loaded = await store.load(SESSION_A);
      expect([testCase.name, loaded.ok]).toEqual([testCase.name, false]);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe("session_corrupted");
      }
    }
  });

  test("flags unpaired context completions", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    });
    const paths = sessionPaths(HOME, SESSION_A);
    storage.files.set(
      paths.history,
      `${storage.files.get(paths.history) ?? ""}${JSON.stringify({
        schemaVersion: 1,
        recordId: crypto.randomUUID(),
        sessionId: SESSION_A,
        turnId: TURN_A,
        runId: RUN_A,
        timestamp: "2026-09-14T08:00:11.000Z",
        kind: "turn.completed",
        status: "succeeded",
        messages: [toolPair()[0] as HistoryMessage],
        includedInContext: true,
        model: "m",
      })}\n`,
    );
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("session_corrupted");
    }
  });

  test("flags duplicate history record ids", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const recordId = crypto.randomUUID();
    const record = {
      schemaVersion: 1,
      recordId,
      sessionId: SESSION_A,
      turnId: TURN_A,
      runId: RUN_A,
      timestamp: "2026-09-14T08:00:00.000Z",
      kind: "turn.accepted",
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "x",
    };
    storage.files.set(
      sessionPaths(HOME, SESSION_A).history,
      `${JSON.stringify(record)}\n${JSON.stringify({ ...record, turnId: TURN_B, runId: RUN_B })}\n`,
    );
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("session_corrupted");
    }
  });

  test("rejects an accepted record from another session or a mismatched run", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const record = {
      schemaVersion: 1,
      recordId: crypto.randomUUID(),
      sessionId: SESSION_B,
      turnId: TURN_A,
      runId: RUN_A,
      timestamp: "2026-09-14T08:00:00.000Z",
      kind: "turn.accepted",
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "x",
    };
    storage.files.set(sessionPaths(HOME, SESSION_A).history, `${JSON.stringify(record)}\n`);
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(false);
  });

  test("does not rewrite a corrupted session and keeps other sessions loadable", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    seedSession(storage, HOME, SESSION_B);
    const corrupt = "not-json\n";
    storage.files.set(sessionPaths(HOME, SESSION_A).history, corrupt);

    const corrupted = await store.load(SESSION_A);
    expect(corrupted.ok).toBe(false);
    expect(storage.files.get(sessionPaths(HOME, SESSION_A).history)).toBe(corrupt);

    const healthy = await store.load(SESSION_B);
    expect(healthy.ok).toBe(true);
  });
});

describe("SessionStore listing", () => {
  test("filters by workspace, hides one_shot, and sorts stably", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A, {
      workspaceRoot: "/workspace/a",
      updatedAt: "2026-09-14T08:00:02.000Z",
    });
    seedSession(storage, HOME, SESSION_B, {
      workspaceRoot: "/workspace/b",
      updatedAt: "2026-09-14T08:00:03.000Z",
    });
    const oneShotId = "550e8400-e29b-41d4-a716-446655440102" as SessionId;
    seedSession(storage, HOME, oneShotId, {
      mode: "one_shot",
      workspaceRoot: "/workspace/a",
      updatedAt: "2026-09-14T08:00:04.000Z",
    });

    const all = await store.list({});
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.sessions.map((session) => session.sessionId)).toEqual([
        SESSION_B,
        SESSION_A,
      ]);
    }

    const filtered = await store.list({ workspaceRoot: "/workspace/a" });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.value.sessions.map((session) => session.sessionId)).toEqual([SESSION_A]);
    }

    const withOneShot = await store.list({ includeOneShot: true });
    expect(withOneShot.ok).toBe(true);
    if (withOneShot.ok) {
      expect(withOneShot.value.sessions).toHaveLength(3);
    }
  });

  test("paginates with an opaque cursor and rejects invalid cursors", async () => {
    const { store, storage } = createMemoryStore(HOME);
    const ids: SessionId[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id =
        `550e8400-e29b-41d4-a716-4466554402${index.toString().padStart(2, "0")}` as SessionId;
      ids.push(id);
      seedSession(storage, HOME, id, {
        updatedAt: `2026-09-14T08:00:0${index}.000Z`,
      });
    }
    const first = await store.list({ limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.sessions).toHaveLength(2);
    expect(first.value.nextCursor).toBeDefined();

    const nextCursor = first.value.nextCursor;
    expect(nextCursor).toBeDefined();
    const second = await store.list(
      nextCursor === undefined ? { limit: 2 } : { limit: 2, cursor: nextCursor },
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.sessions).toHaveLength(1);
      expect(second.value.nextCursor).toBeUndefined();
      expect(second.value.sessions[0]?.sessionId).toBe(ids[0]);
    }

    const invalid = await store.list({ cursor: "not-a-cursor" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid_cursor");
    }
  });

  test("lists a corrupt session as corrupted without exposing details", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    storage.files.set(sessionPaths(HOME, SESSION_A).history, "broken\n");
    const page = await store.list({});
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.sessions[0]?.status).toBe("corrupted");
    }
  });

  test("surfaces list io failures", async () => {
    const { store, storage } = createMemoryStore(HOME);
    storage.listError = new Error("boom");
    const page = await store.list({});
    expect(page.ok).toBe(false);
    if (!page.ok) {
      expect(page.error.code).toBe("io_error");
    }
  });
});

describe("SessionStore context building", () => {
  test("includes only succeeded turns in original order", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const turns = [
      { turnId: TURN_A, runId: RUN_A, clientMessageId: CLIENT_MESSAGE_A, status: "succeeded" },
      { turnId: TURN_B, runId: RUN_B, clientMessageId: CLIENT_MESSAGE_B, status: "failed" },
      { turnId: TURN_C, runId: RUN_C, clientMessageId: CLIENT_MESSAGE_C, status: "succeeded" },
    ] as const;
    for (const [index, entry] of turns.entries()) {
      await store.appendAccepted(SESSION_A, {
        turnId: entry.turnId,
        runId: entry.runId,
        clientMessageId: entry.clientMessageId,
        userMessage: `question-${index}`,
      });
      await store.appendCompleted(SESSION_A, {
        turnId: entry.turnId,
        runId: entry.runId,
        status: entry.status,
        messages: [
          { ...userMessage(`question-${index}`), turnId: entry.turnId, runId: entry.runId },
          { ...assistantMessage(`answer-${index}`), turnId: entry.turnId, runId: entry.runId },
        ],
        model: "m",
      });
    }
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const messages = buildContextMessages(loaded.value.turns);
    expect(messages).toHaveLength(4);
    const texts = messages.flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
    expect(texts).toEqual(["question-0", "answer-0", "question-2", "answer-2"]);
  });

  test("maps tool call and tool result blocks to provider-neutral messages", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    await store.appendAccepted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "read it",
    });
    await store.appendCompleted(SESSION_A, {
      turnId: TURN_A,
      runId: RUN_A,
      status: "succeeded",
      messages: [userMessage("read it"), ...toolPair(), assistantMessage("done")],
      model: "m",
    });
    const loaded = await store.load(SESSION_A);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const messages = buildContextMessages(loaded.value.turns);
    const blocks = messages.flatMap((message) => message.content);
    expect(blocks.some((block) => block.type === "tool_use")).toBe(true);
    expect(blocks.some((block) => block.type === "tool_result")).toBe(true);
  });
});

describe("deriveTitle", () => {
  test("uses the first non-empty trimmed line and falls back to the default", () => {
    expect(deriveTitle("\n  hello world  \nsecond")).toBe("hello world");
    expect(deriveTitle("   ")).toBe(NEW_SESSION_TITLE);
  });
});

describe("SessionStore filesystem behavior", () => {
  test("writes only under the configured home with private permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-session-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-workspace-"));
    try {
      const store = new SessionStore(home, nodeSessionStorage);
      const created = await store.create({ mode: "chat", workspaceRoot: workspace });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const sessionId = created.value.meta.sessionId;
      const directory = join(home, "sessions", sessionId);
      const directoryMode = (await stat(directory)).mode & 0o777;
      expect(directoryMode).toBe(0o700);
      const metaMode = (await stat(join(directory, "meta.json"))).mode & 0o777;
      expect(metaMode).toBe(0o600);

      await store.appendAccepted(sessionId, {
        turnId: TURN_A,
        runId: RUN_A,
        clientMessageId: CLIENT_MESSAGE_A,
        userMessage: "hello",
      });
      const historyMode = (await stat(join(directory, "history.jsonl"))).mode & 0o777;
      expect(historyMode).toBe(0o600);
      const historyContent = await readFile(join(directory, "history.jsonl"), "utf8");
      expect(historyContent.endsWith("\n")).toBe(true);

      // workspace 与 cwd 都不得出现 session 文件。
      expect(await readdir(workspace)).toEqual([]);

      const reloaded = await new SessionStore(home, nodeSessionStorage).load(sessionId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value.turns).toHaveLength(1);
        expect(reloaded.value.meta.workspaceRoot).toBe(await realpath(workspace));
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not leave temporary files behind after atomic meta writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-session-"));
    try {
      const store = new SessionStore(home, nodeSessionStorage);
      const created = await store.create({ mode: "chat", workspaceRoot: home });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const entries = await readdir(join(home, "sessions", created.value.meta.sessionId));
      expect(entries.sort()).toEqual([
        "history.jsonl",
        "meta.json",
        "notes.md",
        "runs",
        "session-events.jsonl",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
