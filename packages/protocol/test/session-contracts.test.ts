import { describe, expect, test } from "bun:test";

import {
  AgentEventSchema,
  DEFAULT_SESSION_LIST_LIMIT,
  EventPushNotificationSchema,
  EVENT_UNSUBSCRIBE_METHOD,
  HistoryTurnSchema,
  JsonRpcErrorCode,
  MAX_HISTORY_TEXT_CHARS,
  MAX_SESSION_LIST_LIMIT,
  SessionCreateRequestSchema,
  SessionCreateResultSchema,
  SessionErrorDataSchema,
  SessionEventSchema,
  SessionGetHistoryResultSchema,
  SessionListParamsSchema,
  SessionListRequestSchema,
  SessionListResultSchema,
  SessionSendMessageParamsSchema,
  SessionSendMessageRequestSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeResultSchema,
  SessionSummarySchema,
  SessionTurnAcceptedEventSchema,
  SessionTurnFinishedEventSchema,
  TaskSnapshotSchema,
  isAgentEvent,
  isSessionEvent,
} from "../src/index.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const turnId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const runId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const clientMessageId = "6ba7b812-9dad-41d1-80b4-00c04fd430c8";
const subscriptionId = "6ba7b813-9dad-41d1-80b4-00c04fd430c8";
const timestamp = "2026-09-14T08:00:00.000Z";

const sessionSummary = {
  sessionId,
  mode: "chat",
  status: "idle",
  title: "New session",
  workspaceRoot: "/workspace",
  createdAt: timestamp,
  updatedAt: timestamp,
  latestSessionSequence: 0,
} as const;

const taskSnapshot = {
  id: 1,
  subject: "Inspect repository",
  description: "Read the README and list the packages",
  status: "pending",
  blocked: false,
  blockedBy: [],
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

describe("session RPC contracts", () => {
  test("defines create, get, list, sendMessage, getHistory, and subscribe methods", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "create-1",
        method: "session.create",
        params: { workspaceRoot: "/workspace" },
      }).success,
    ).toBe(true);
    expect(
      SessionListRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "list-1",
        method: "session.list",
        params: {},
      }).success,
    ).toBe(true);
    expect(
      SessionSendMessageRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "send-1",
        method: "session.sendMessage",
        params: { sessionId, clientMessageId, content: "hello" },
      }).success,
    ).toBe(true);
    expect(
      SessionSubscribeRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "sub-1",
        method: "session.subscribe",
        params: { sessionId, afterSequence: 0 },
      }).success,
    ).toBe(true);
  });

  test("requires UUID session/turn/run/client identities in results", () => {
    expect(SessionCreateResultSchema.safeParse({ session: sessionSummary }).success).toBe(true);
    expect(
      SessionCreateResultSchema.safeParse({
        session: { ...sessionSummary, sessionId: "not-a-uuid" },
      }).success,
    ).toBe(false);
    expect(
      SessionSubscribeResultSchema.safeParse({
        subscriptionId,
        sessionId,
        latestSequence: 3,
        activeRun: { turnId, runId },
      }).success,
    ).toBe(true);
  });

  test("rejects unknown fields on session summaries and results", () => {
    expect(SessionSummarySchema.safeParse({ ...sessionSummary, extra: true }).success).toBe(false);
    expect(
      SessionCreateResultSchema.safeParse({ session: sessionSummary, extra: true }).success,
    ).toBe(false);
  });
});

describe("session.list filtering, sorting, and pagination bounds", () => {
  test("defaults includeOneShot to false and limit to 50", () => {
    const parsed = SessionListParamsSchema.parse({});
    expect(parsed.includeOneShot).toBe(false);
    expect(parsed.limit).toBe(DEFAULT_SESSION_LIST_LIMIT);
    expect(parsed.workspaceRoot).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  test("accepts an explicit workspace filter and opaque cursor", () => {
    const parsed = SessionListParamsSchema.parse({
      workspaceRoot: "/workspace",
      includeOneShot: true,
      cursor: "opaque-cursor-token",
      limit: 100,
    });
    expect(parsed.workspaceRoot).toBe("/workspace");
    expect(parsed.includeOneShot).toBe(true);
    expect(parsed.cursor).toBe("opaque-cursor-token");
    expect(parsed.limit).toBe(MAX_SESSION_LIST_LIMIT);
  });

  test("rejects out-of-range limits, empty cursors, and unknown fields", () => {
    expect(SessionListParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(SessionListParamsSchema.safeParse({ limit: MAX_SESSION_LIST_LIMIT + 1 }).success).toBe(
      false,
    );
    expect(SessionListParamsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(SessionListParamsSchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(SessionListParamsSchema.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
    expect(SessionListParamsSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  test("expresses a next page with an opaque cursor", () => {
    expect(
      SessionListResultSchema.safeParse({ sessions: [sessionSummary], nextCursor: "page-2" })
        .success,
    ).toBe(true);
    expect(
      SessionListResultSchema.safeParse({ sessions: [sessionSummary], nextCursor: "" }).success,
    ).toBe(false);
  });
});

describe("session message validation", () => {
  test("trims content and rejects empty or oversized messages", () => {
    expect(
      SessionSendMessageParamsSchema.parse({ sessionId, clientMessageId, content: "  hi " })
        .content,
    ).toBe("hi");
    expect(
      SessionSendMessageParamsSchema.safeParse({ sessionId, clientMessageId, content: "   " })
        .success,
    ).toBe(false);
    expect(
      SessionSendMessageParamsSchema.safeParse({
        sessionId,
        clientMessageId,
        content: "x".repeat(32 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      SessionSendMessageParamsSchema.safeParse({
        sessionId,
        clientMessageId,
        content: "hi",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  test("requires a client-generated UUID idempotency key", () => {
    expect(
      SessionSendMessageParamsSchema.safeParse({ sessionId, clientMessageId: "1", content: "hi" })
        .success,
    ).toBe(false);
  });
});

describe("session events and push scope", () => {
  test("accepts turn_accepted and turn_finished as a strict discriminated union", () => {
    const accepted = {
      sessionId,
      sessionSequence: 1,
      timestamp,
      durable: true,
      type: "session.turn_accepted",
      payload: { turnId, runId, clientMessageId, userMessage: "hello" },
    } as const;
    const finished = {
      sessionId,
      sessionSequence: 2,
      timestamp,
      durable: true,
      type: "session.turn_finished",
      payload: { turnId, runId, status: "succeeded", reason: "completed" },
    } as const;

    expect(SessionTurnAcceptedEventSchema.parse(accepted)).toEqual(accepted);
    expect(SessionTurnFinishedEventSchema.parse(finished)).toEqual(finished);
    expect(SessionEventSchema.safeParse(accepted).success).toBe(true);
    expect(SessionEventSchema.safeParse(finished).success).toBe(true);
  });

  test("rejects session events without sessionId, with run sequence, or unknown fields", () => {
    const base = {
      sessionId,
      sessionSequence: 1,
      timestamp,
      durable: true,
      type: "session.turn_accepted",
      payload: { turnId, runId, clientMessageId, userMessage: "hello" },
    };
    const { sessionId: _removed, ...withoutSession } = base;
    expect(SessionEventSchema.safeParse(withoutSession).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...base, sequence: 1 }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...base, sessionSequence: 0 }).success).toBe(false);
    expect(
      SessionEventSchema.safeParse({ ...base, payload: { ...base.payload, extra: 1 } }).success,
    ).toBe(false);
  });

  test("event.push carries both run and session events with a subscription id", () => {
    const runPush = {
      jsonrpc: "2.0",
      method: "event.push",
      params: {
        subscriptionId,
        event: {
          sessionId,
          runId,
          sequence: 1,
          timestamp,
          durable: true,
          type: "run.started",
          payload: {},
        },
      },
    } as const;
    const sessionPush = {
      jsonrpc: "2.0",
      method: "event.push",
      params: {
        subscriptionId,
        event: {
          sessionId,
          sessionSequence: 1,
          timestamp,
          durable: true,
          type: "session.turn_finished",
          payload: { turnId, runId, status: "succeeded", reason: "completed" },
        },
      },
    } as const;

    expect(EventPushNotificationSchema.safeParse(runPush).success).toBe(true);
    const parsed = EventPushNotificationSchema.safeParse(sessionPush);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isAgentEvent(parsed.data.params.event)).toBe(false);
      expect(isSessionEvent(parsed.data.params.event)).toBe(true);
    }
    const parsedRun = EventPushNotificationSchema.parse(runPush);
    expect(isAgentEvent(parsedRun.params.event)).toBe(true);
    expect(isSessionEvent(parsedRun.params.event)).toBe(false);
  });

  test("can express response-before-event for a paused session subscription", () => {
    // 暂停订阅时，响应只需要 subscriptionId/latestSequence/activeRun；
    // 第一个 session event 作为后续独立帧到达，且序号严格大于回放游标。
    const subscribeResult = {
      jsonrpc: "2.0",
      id: "sub-1",
      result: { subscriptionId, sessionId, latestSequence: 4, activeRun: { turnId, runId } },
    };
    expect(SessionSubscribeResultSchema.safeParse(subscribeResult.result).success).toBe(true);

    const firstEvent = {
      jsonrpc: "2.0",
      method: "event.push",
      params: {
        subscriptionId,
        event: {
          sessionId,
          sessionSequence: 5,
          timestamp,
          durable: true,
          type: "session.turn_accepted",
          payload: { turnId, runId, clientMessageId, userMessage: "hello" },
        },
      },
    };
    const parsed = EventPushNotificationSchema.safeParse(firstEvent);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isSessionEvent(parsed.data.params.event)).toBe(true);
      if (isSessionEvent(parsed.data.params.event)) {
        expect(parsed.data.params.event.sessionSequence).toBeGreaterThan(
          subscribeResult.result.latestSequence,
        );
      }
    }
  });

  test("a durable, replayable llm.text_delta round-trips through the run event schema", () => {
    const durableDelta = {
      sessionId,
      runId,
      sequence: 4,
      timestamp,
      durable: true,
      type: "llm.text_delta",
      payload: { text: "partial" },
    } as const;
    expect(AgentEventSchema.parse(durableDelta)).toEqual(durableDelta);
  });

  test("rejects transient transcript deltas and retry events", () => {
    const requiredDurableEvents = [
      { type: "llm.text_delta", payload: { text: "partial" } },
      {
        type: "llm.retrying",
        payload: { attempt: 2, maxAttempts: 3, delayMs: 10, reason: "network" },
      },
      {
        type: "tool.retrying",
        payload: {
          toolCallId: "call-1",
          name: "read_file",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 10,
          errorCode: "busy",
        },
      },
    ] as const;
    for (const event of requiredDurableEvents) {
      const base = { sessionId, runId, sequence: 1, timestamp, ...event };
      expect(AgentEventSchema.safeParse({ ...base, durable: false }).success).toBe(false);
      expect(AgentEventSchema.safeParse({ ...base, durable: true }).success).toBe(true);
    }
  });
});

describe("task events", () => {
  test("task.created and task.updated carry a revision and a full snapshot", () => {
    const base = { sessionId, runId, sequence: 2, timestamp, durable: true } as const;
    const events = [
      {
        ...base,
        type: "task.created" as const,
        payload: { revision: 3, task: taskSnapshot },
      },
      {
        ...base,
        type: "task.updated" as const,
        payload: { revision: 3, task: taskSnapshot },
      },
    ];
    for (const event of events) {
      const parsed = AgentEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
  });

  test("rejects a task event without a revision or with an incomplete snapshot", () => {
    expect(
      AgentEventSchema.safeParse({
        sessionId,
        runId,
        sequence: 2,
        timestamp,
        durable: true,
        type: "task.created",
        payload: { task: taskSnapshot },
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        sessionId,
        runId,
        sequence: 2,
        timestamp,
        durable: true,
        type: "task.updated",
        payload: { revision: 0, task: { ...taskSnapshot, blocked: undefined } },
      }).success,
    ).toBe(false);
  });

  test("task snapshots validate identity and length bounds", () => {
    expect(TaskSnapshotSchema.safeParse(taskSnapshot).success).toBe(true);
    expect(TaskSnapshotSchema.safeParse({ ...taskSnapshot, id: 0 }).success).toBe(false);
    expect(TaskSnapshotSchema.safeParse({ ...taskSnapshot, subject: "" }).success).toBe(false);
    expect(
      TaskSnapshotSchema.safeParse({ ...taskSnapshot, subject: "x".repeat(121) }).success,
    ).toBe(false);
    expect(TaskSnapshotSchema.safeParse({ ...taskSnapshot, status: "blocked" }).success).toBe(
      false,
    );
  });
});

describe("provider-neutral history", () => {
  const userMessage = {
    messageId: "message-1",
    turnId,
    runId,
    role: "user",
    timestamp,
    content: [{ type: "text", text: "read the file" }],
  } as const;

  test("accepts a completed history turn with a task graph", () => {
    const turn = {
      turnId,
      runId,
      clientMessageId,
      status: "succeeded",
      reason: "completed",
      acceptedAt: timestamp,
      finishedAt: timestamp,
      includedInContext: true,
      taskGraph: { revision: 1, tasks: [taskSnapshot] },
      messages: [
        userMessage,
        {
          messageId: "message-2",
          turnId,
          runId,
          role: "assistant",
          timestamp,
          content: [{ type: "text", text: "done" }],
        },
      ],
    };
    expect(HistoryTurnSchema.safeParse(turn).success).toBe(true);
    expect(
      SessionGetHistoryResultSchema.safeParse({
        session: sessionSummary,
        turns: [turn],
        throughSessionSequence: 3,
      }).success,
    ).toBe(true);
  });

  test("rejects unpaired tool blocks in a context-included turn", () => {
    const unpaired = {
      turnId,
      runId,
      clientMessageId,
      status: "succeeded",
      acceptedAt: timestamp,
      finishedAt: timestamp,
      includedInContext: true,
      messages: [
        {
          messageId: "message-1",
          turnId,
          runId,
          role: "assistant",
          timestamp,
          content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
        },
      ],
    };
    expect(HistoryTurnSchema.safeParse(unpaired).success).toBe(false);

    // 结果块在前、缺少对应 tool_use 也必须被拒绝。
    expect(
      HistoryTurnSchema.safeParse({
        ...unpaired,
        messages: [
          {
            messageId: "message-1",
            turnId,
            runId,
            role: "user",
            timestamp,
            content: [{ type: "tool_result", toolUseId: "call-1", content: "ok" }],
          },
        ],
      }).success,
    ).toBe(false);

    const paired = {
      ...unpaired,
      messages: [
        unpaired.messages[0],
        {
          messageId: "message-2",
          turnId,
          runId,
          role: "user",
          timestamp,
          content: [{ type: "tool_result", toolUseId: "call-1", content: "ok" }],
        },
      ],
    };
    expect(HistoryTurnSchema.safeParse(paired).success).toBe(true);

    const duplicateUse = {
      ...unpaired,
      messages: [unpaired.messages[0], unpaired.messages[0], paired.messages[1]],
    };
    expect(HistoryTurnSchema.safeParse(duplicateUse).success).toBe(false);
  });

  test("rejects messages with foreign turn/run identities and oversized text", () => {
    const baseTurn = {
      turnId,
      runId,
      clientMessageId,
      status: "succeeded",
      reason: "completed",
      acceptedAt: timestamp,
      finishedAt: timestamp,
      includedInContext: true,
      messages: [userMessage],
    } as const;
    expect(
      HistoryTurnSchema.safeParse({
        ...baseTurn,
        messages: [{ ...userMessage, turnId: "6ba7b810-9dad-41d1-80b4-00c04fd430c9" }],
      }).success,
    ).toBe(false);
    expect(
      HistoryTurnSchema.safeParse({
        ...baseTurn,
        messages: [{ ...userMessage, runId: "6ba7b811-9dad-41d1-80b4-00c04fd430c9" }],
      }).success,
    ).toBe(false);
    expect(
      HistoryTurnSchema.safeParse({
        ...baseTurn,
        messages: [
          {
            ...userMessage,
            content: [{ type: "text", text: "x".repeat(MAX_HISTORY_TEXT_CHARS + 1) }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects a non-succeeded turn marked includedInContext", () => {
    expect(
      HistoryTurnSchema.safeParse({
        turnId,
        runId,
        clientMessageId,
        status: "failed",
        acceptedAt: timestamp,
        includedInContext: true,
        messages: [userMessage],
      }).success,
    ).toBe(false);
  });

  test("allows failed and interrupted turns to stay in audit history", () => {
    for (const status of ["failed", "cancelled", "interrupted", "running"] as const) {
      expect(
        HistoryTurnSchema.safeParse({
          turnId,
          runId,
          clientMessageId,
          status,
          acceptedAt: timestamp,
          includedInContext: false,
          messages: [userMessage],
        }).success,
      ).toBe(true);
    }
  });
});

describe("session error contracts", () => {
  test("reserves stable Stage2 error codes", () => {
    expect(JsonRpcErrorCode.sessionNotFound).toBe(-32010);
    expect(JsonRpcErrorCode.sessionBusy).toBe(-32011);
    expect(JsonRpcErrorCode.sessionCorrupted).toBe(-32012);
    expect(JsonRpcErrorCode.contextLimitExceeded).toBe(-32013);
    expect(JsonRpcErrorCode.oneShotNotResumable).toBe(-32014);
  });

  test("only allows safe diagnostic fields in error data", () => {
    expect(SessionErrorDataSchema.safeParse({ sessionId, turnId, runId }).success).toBe(true);
    expect(SessionErrorDataSchema.safeParse({ sessionId }).success).toBe(true);
    expect(
      SessionErrorDataSchema.safeParse({ sessionId, workspaceRoot: "/secret", prompt: "x" })
        .success,
    ).toBe(false);
  });

  test("keeps event.unsubscribe as the subscription release method", () => {
    expect(EVENT_UNSUBSCRIBE_METHOD).toBe("event.unsubscribe");
  });
});
