import { describe, expect, test } from "bun:test";

import {
  AgentCancelRequestSchema,
  AgentRunRequestSchema,
  AgentRunResultSchema,
  EventPushNotificationSchema,
  EventSubscribeParamsSchema,
  JsonRpcErrorCode,
  JsonRpcNotificationEnvelopeSchema,
  RunFinishedEventSchema,
  ToolFinishedEventSchema,
} from "../src/index.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const subscriptionId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const eventBase = {
  sessionId,
  runId,
  sequence: 1,
  timestamp: "2026-09-13T08:00:00.000Z",
  durable: true,
};

describe("agent RPC schemas", () => {
  test("strictly validates run, cancel, and subscribe inputs", () => {
    expect(
      AgentRunRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "run-1",
        method: "agent.run",
        params: { goal: "总结 README", workspaceRoot: "/workspace" },
      }).success,
    ).toBe(true);
    expect(
      AgentCancelRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "agent.cancel",
        params: { sessionId, runId, extra: true },
      }).success,
    ).toBe(false);
    expect(
      EventSubscribeParamsSchema.safeParse({ sessionId, runId, afterSequence: 0 }).success,
    ).toBe(true);
    expect(
      EventSubscribeParamsSchema.safeParse({ sessionId, runId, afterSequence: -1 }).success,
    ).toBe(false);
  });

  test("requires UUID identities and an accepted run result", () => {
    expect(
      AgentRunResultSchema.safeParse({ status: "accepted", sessionId, runId, subscriptionId })
        .success,
    ).toBe(true);
    expect(
      AgentRunResultSchema.safeParse({
        status: "accepted",
        sessionId: "shared-session",
        runId,
        subscriptionId,
      }).success,
    ).toBe(false);
  });

  test("publishes the application-level missing run error code", () => {
    expect(JsonRpcErrorCode.runNotFound).toBe(-32001);
  });
});

describe("agent event schemas", () => {
  test("accepts a typed tool completion notification", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "event.push",
      params: {
        subscriptionId,
        event: {
          ...eventBase,
          type: "tool.finished",
          payload: {
            toolCallId: "call-1",
            name: "read_file",
            isError: false,
            durationMs: 8,
            outputBytes: 42,
            truncated: false,
          },
        },
      },
    } as const;

    expect(EventPushNotificationSchema.parse(notification)).toEqual(notification);
    expect(JsonRpcNotificationEnvelopeSchema.safeParse(notification).success).toBe(true);
  });

  test("accepts context window metadata while remaining compatible with old usage events", () => {
    const usageEvent = {
      ...eventBase,
      type: "llm.usage",
      payload: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
      },
    } as const;
    expect(
      EventPushNotificationSchema.safeParse({
        jsonrpc: "2.0",
        method: "event.push",
        params: { subscriptionId, event: usageEvent },
      }).success,
    ).toBe(true);
    expect(
      EventPushNotificationSchema.safeParse({
        jsonrpc: "2.0",
        method: "event.push",
        params: {
          subscriptionId,
          event: {
            ...usageEvent,
            payload: { ...usageEvent.payload, contextWindowTokens: 200_000 },
          },
        },
      }).success,
    ).toBe(true);
  });

  test("rejects event payloads that do not match their discriminator", () => {
    expect(
      ToolFinishedEventSchema.safeParse({
        ...eventBase,
        type: "tool.finished",
        payload: { toolCallId: "call-1", name: "read_file", isError: false },
      }).success,
    ).toBe(false);
    expect(
      EventPushNotificationSchema.safeParse({
        jsonrpc: "2.0",
        method: "event.push",
        params: {
          subscriptionId,
          event: { ...eventBase, type: "unknown.event", payload: {} },
        },
      }).success,
    ).toBe(false);
  });

  test("enforces terminal status and reason combinations", () => {
    const result = {
      ...eventBase,
      type: "run.finished",
      payload: {
        status: "failed",
        reason: "llm_error",
        finalText: "",
        steps: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        error: { code: "provider_unavailable", message: "Provider unavailable" },
      },
    };
    expect(RunFinishedEventSchema.safeParse(result).success).toBe(true);
    expect(
      RunFinishedEventSchema.safeParse({
        ...result,
        payload: { ...result.payload, status: "succeeded", reason: "llm_error" },
      }).success,
    ).toBe(false);
  });
});
