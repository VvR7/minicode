import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  SESSION_SCHEMA_VERSION,
  SessionEventRecordSchema,
  SessionMetaSchema,
  TurnAcceptedRecordSchema,
  TurnCompletedRecordSchema,
} from "../../src/session/types.ts";
import { RUN_A, SESSION_A, TURN_A } from "./test-helpers.ts";

/** 以 unknown 调用 schema，避免 zod 的输入重载掩盖运行时校验行为。 */
function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

const meta = {
  schemaVersion: SESSION_SCHEMA_VERSION,
  sessionId: SESSION_A,
  mode: "chat",
  workspaceRoot: "/workspace",
  title: "New session",
  createdAt: "2026-09-14T08:00:00.000Z",
  updatedAt: "2026-09-14T08:00:00.000Z",
};

const accepted = {
  schemaVersion: SESSION_SCHEMA_VERSION,
  recordId: crypto.randomUUID(),
  sessionId: SESSION_A,
  turnId: TURN_A,
  runId: RUN_A,
  timestamp: "2026-09-14T08:00:00.000Z",
  kind: "turn.accepted",
  clientMessageId: "6ba7b830-9dad-41d1-80b4-00c04fd430c0",
  userMessage: "hello",
};

const completed = {
  schemaVersion: SESSION_SCHEMA_VERSION,
  recordId: crypto.randomUUID(),
  sessionId: SESSION_A,
  turnId: TURN_A,
  runId: RUN_A,
  timestamp: "2026-09-14T08:00:01.000Z",
  kind: "turn.completed",
  status: "succeeded",
  reason: "completed",
  messages: [
    {
      messageId: crypto.randomUUID(),
      turnId: TURN_A,
      runId: RUN_A,
      role: "user",
      timestamp: "2026-09-14T08:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
    },
  ],
  includedInContext: true,
  model: "test-model",
};

describe("session persistence schemas", () => {
  test("round-trips meta, history, and session event records", () => {
    const parsedMeta = SessionMetaSchema.safeParse(meta as unknown);
    expect(parsedMeta.success).toBe(true);
    if (parsedMeta.success) {
      expect(parsedMeta.data.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
      expect(parsedMeta.data.mode).toBe("chat");
      expect(parsedMeta.data.title).toBe(meta.title);
      expect(parsedMeta.data.sessionId).toBe(meta.sessionId);
    }
    expect(accepts(TurnAcceptedRecordSchema, accepted)).toBe(true);

    const event = {
      sessionId: SESSION_A,
      sessionSequence: 1,
      timestamp: "2026-09-14T08:00:00.000Z",
      durable: true,
      type: "session.turn_accepted",
      payload: {
        turnId: TURN_A,
        runId: RUN_A,
        clientMessageId: accepted.clientMessageId,
        userMessage: "hello",
      },
    };
    expect(
      accepts(SessionEventRecordSchema, {
        schemaVersion: SESSION_SCHEMA_VERSION,
        recordId: crypto.randomUUID(),
        event,
      }),
    ).toBe(true);
  });

  test("rejects unknown versions and unknown fields", () => {
    expect(accepts(SessionMetaSchema, { ...meta, schemaVersion: 2 })).toBe(false);
    expect(accepts(SessionMetaSchema, { ...meta, extra: true })).toBe(false);
    expect(accepts(TurnAcceptedRecordSchema, { ...accepted, schemaVersion: 2 })).toBe(false);
    expect(accepts(TurnAcceptedRecordSchema, { ...accepted, extra: 1 })).toBe(false);
  });

  test("allows context inclusion only for succeeded completions", () => {
    expect(accepts(TurnCompletedRecordSchema, completed)).toBe(true);
    expect(
      accepts(TurnCompletedRecordSchema, {
        ...completed,
        status: "failed",
        includedInContext: true,
      }),
    ).toBe(false);
    expect(
      accepts(TurnCompletedRecordSchema, {
        ...completed,
        status: "failed",
        includedInContext: false,
      }),
    ).toBe(true);
  });
});
