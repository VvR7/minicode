import { describe, expect, test } from "bun:test";
import {
  CompactionResultSchema,
  ContextMessageMetadataSchema,
  EventPushNotificationSchema,
  isSessionEvent,
  SessionCompactParamsSchema,
  SessionCompactRequestSchema,
  SessionCompactResultSchema,
  SessionCompactSuccessResponseSchema,
  SessionEventSchema,
} from "../src/index.ts";
const id = "550e8400-e29b-41d4-a716-446655440001";
const result = {
  compactionId: id,
  kind: "summary",
  firstKeptMessageId: "m1",
  tokensBefore: 190000,
  tokensAfter: 24000,
};
const base = {
  sessionId: id,
  sessionSequence: 1,
  timestamp: "2026-09-17T00:00:00Z",
  durable: true,
};
describe("compaction contracts", () => {
  test("manual params and response are strict and scoped", () => {
    expect(
      SessionCompactParamsSchema.parse({ sessionId: id, focus: "  preserve goals  " }).focus,
    ).toBe("preserve goals");
    for (const params of [
      {},
      { sessionId: "bad" },
      { sessionId: id, focus: "x".repeat(32769) },
      { sessionId: id, runId: id },
    ])
      expect(SessionCompactParamsSchema.safeParse(params).success).toBe(false);
    expect(
      SessionCompactRequestSchema.safeParse({
        jsonrpc: "2.0",
        id,
        method: "session.compact",
        params: { sessionId: id },
      }).success,
    ).toBe(true);
    expect(
      SessionCompactSuccessResponseSchema.safeParse({
        jsonrpc: "2.0",
        id,
        result: { sessionId: id, status: "compacted", result },
      }).success,
    ).toBe(true);
    expect(
      SessionCompactResultSchema.safeParse({ sessionId: id, status: "unchanged" }).success,
    ).toBe(true);
    expect(
      SessionCompactResultSchema.safeParse({ sessionId: id, status: "compacted" }).success,
    ).toBe(false);
    expect(
      SessionCompactResultSchema.safeParse({ sessionId: id, status: "unchanged", result }).success,
    ).toBe(false);
  });
  test("summary and fallback metadata reject malformed values", () => {
    for (const kind of ["summary", "fallback"])
      expect(ContextMessageMetadataSchema.safeParse({ kind, compactionId: id }).success).toBe(true);
    expect(ContextMessageMetadataSchema.safeParse({ kind: "text", compactionId: id }).success).toBe(
      false,
    );
    expect(CompactionResultSchema.safeParse({ ...result, tokensAfter: -1 }).success).toBe(false);
  });
  test("all compaction events pass push parsing with session scope", () => {
    const events = [
      {
        ...base,
        type: "session.compaction_started",
        payload: { compactionId: id, reason: "threshold", tokensBefore: 190000 },
      },
      {
        ...base,
        type: "session.compaction_finished",
        payload: { reason: "manual", result: { ...result, kind: "fallback" } },
      },
      {
        ...base,
        type: "session.compaction_failed",
        payload: {
          compactionId: id,
          reason: "context_error",
          code: "summary_failed",
          message: "summary failed",
        },
      },
    ];
    for (const event of events) {
      const parsed = EventPushNotificationSchema.parse({
        jsonrpc: "2.0",
        method: "event.push",
        params: { subscriptionId: id, event },
      });
      expect(isSessionEvent(parsed.params.event)).toBe(true);
      expect(SessionEventSchema.safeParse({ ...event, sessionId: undefined }).success).toBe(false);
      expect(SessionEventSchema.safeParse({ ...event, runId: id }).success).toBe(false);
      expect(
        SessionEventSchema.safeParse({ ...event, payload: { ...event.payload, secret: "x" } })
          .success,
      ).toBe(false);
    }
  });
});
