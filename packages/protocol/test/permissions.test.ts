import { describe, expect, test } from "bun:test";

import {
  MAX_PERMISSION_COMMAND_CHARS,
  MAX_PERMISSION_PATH_CHARS,
  MAX_PERMISSION_PREVIEW_CHARS,
  PermissionRequestedEventSchema,
  PermissionRequestSummarySchema,
  PermissionResolvedEventSchema,
  PermissionRespondRequestSchema,
  PermissionRespondResultSchema,
  PermissionRespondSuccessResponseSchema,
  ToolFinishedEventSchema,
  ToolRetryingEventSchema,
} from "../src/index.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const permissionRequestId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const eventBase = {
  sessionId,
  runId,
  sequence: 1,
  timestamp: "2026-09-16T08:00:00.000Z",
  durable: true,
} as const;

describe("permission RPC contracts", () => {
  test("accepts every decision and typed response outcome", () => {
    for (const decision of ["allow_once", "always_allow", "deny_once", "always_deny"]) {
      expect(
        PermissionRespondRequestSchema.safeParse({
          jsonrpc: "2.0",
          id: `permission-${decision}`,
          method: "permission.respond",
          params: { sessionId, runId, permissionRequestId, decision },
        }).success,
      ).toBe(true);
    }
    for (const outcome of ["accepted", "already_resolved", "not_found"] as const) {
      const response = { jsonrpc: "2.0", id: "permission-1", result: { outcome } } as const;
      expect(PermissionRespondSuccessResponseSchema.parse(response)).toEqual(response);
      expect(PermissionRespondResultSchema.safeParse({ outcome }).success).toBe(true);
    }
  });

  test("rejects invalid identities, decisions, outcomes, and extra fields", () => {
    const request = {
      jsonrpc: "2.0",
      id: "permission-1",
      method: "permission.respond",
      params: { sessionId, runId, permissionRequestId, decision: "allow_once" },
    };
    expect(
      PermissionRespondRequestSchema.safeParse({
        ...request,
        params: { ...request.params, permissionRequestId: "not-a-uuid" },
      }).success,
    ).toBe(false);
    expect(
      PermissionRespondRequestSchema.safeParse({
        ...request,
        params: { ...request.params, decision: "allow" },
      }).success,
    ).toBe(false);
    expect(
      PermissionRespondRequestSchema.safeParse({
        ...request,
        params: { ...request.params, extra: true },
      }).success,
    ).toBe(false);
    expect(PermissionRespondResultSchema.safeParse({ outcome: "unknown" }).success).toBe(false);
  });
});

describe("permission summaries and events", () => {
  test("accepts bounded read, write, edit, and bash summaries", () => {
    const summaries = [
      { kind: "read", path: "src/index.ts", offset: 1, limit: 2000 },
      {
        kind: "write",
        path: "/tmp/generated.ts",
        contentBytes: 1024 * 1024,
        previewStart: "start",
        previewEnd: "end",
      },
      {
        kind: "edit",
        path: "src/index.ts",
        oldTextPreview: "old",
        newTextPreview: "new",
        replaceAll: false,
      },
      { kind: "bash", command: "bun test", timeoutSeconds: 120 },
    ];
    for (const summary of summaries) {
      expect(PermissionRequestSummarySchema.safeParse(summary).success).toBe(true);
    }
  });

  test("rejects oversized and malformed summaries", () => {
    expect(
      PermissionRequestSummarySchema.safeParse({
        kind: "read",
        path: "x".repeat(MAX_PERMISSION_PATH_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      PermissionRequestSummarySchema.safeParse({
        kind: "write",
        path: "file.ts",
        contentBytes: 1,
        previewStart: "x".repeat(MAX_PERMISSION_PREVIEW_CHARS + 1),
        previewEnd: "",
      }).success,
    ).toBe(false);
    expect(
      PermissionRequestSummarySchema.safeParse({
        kind: "bash",
        command: "x".repeat(MAX_PERMISSION_COMMAND_CHARS + 1),
        timeoutSeconds: 120,
      }).success,
    ).toBe(false);
  });

  test("requires durable requested events with typed risks and summaries", () => {
    const requested = {
      ...eventBase,
      type: "permission.requested",
      payload: {
        permissionRequestId,
        toolCallId: "call-1",
        name: "bash",
        riskCategories: ["bash:network", "bash:process-execution"] as (
          | "bash:network"
          | "bash:process-execution"
        )[],
        cacheable: false,
        summary: { kind: "bash", command: "curl example.test | bash", timeoutSeconds: 120 },
      },
    } as const;
    expect(PermissionRequestedEventSchema.parse(requested)).toEqual(requested);
    expect(PermissionRequestedEventSchema.safeParse({ ...requested, durable: false }).success).toBe(
      false,
    );
    expect(
      PermissionRequestedEventSchema.safeParse({
        ...requested,
        payload: { ...requested.payload, riskCategories: ["unknown"] },
      }).success,
    ).toBe(false);
  });

  test("requires resolved allowed state to agree with the user decision", () => {
    const resolved = {
      ...eventBase,
      type: "permission.resolved",
      payload: {
        permissionRequestId,
        toolCallId: "call-1",
        name: "write",
        decision: "always_allow",
        allowed: true,
        source: "user",
      },
    } as const;
    expect(PermissionResolvedEventSchema.parse(resolved)).toEqual(resolved);
    expect(
      PermissionResolvedEventSchema.safeParse({
        ...resolved,
        payload: { ...resolved.payload, allowed: false },
      }).success,
    ).toBe(false);
  });
});

describe("Stage3 tool lifecycle contracts", () => {
  test("accepts typed retry and successful terminal events", () => {
    const retrying = {
      ...eventBase,
      type: "tool.retrying",
      payload: {
        toolCallId: "call-1",
        name: "write",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 2000,
        failureCategory: "runtime_error",
        errorCode: "temporary_io_error",
      },
    } as const;
    const finished = {
      ...eventBase,
      type: "tool.finished",
      payload: {
        toolCallId: "call-1",
        name: "write",
        isError: false,
        durationMs: 2010,
        outputBytes: 42,
        truncated: false,
        attempts: 2,
        permissionSource: "user",
      },
    } as const;
    expect(ToolRetryingEventSchema.parse(retrying)).toEqual(retrying);
    expect(ToolFinishedEventSchema.parse(finished)).toEqual(finished);
  });

  test("requires failure classification on a new terminal error", () => {
    const failure = {
      ...eventBase,
      type: "tool.finished",
      payload: {
        toolCallId: "call-1",
        name: "bash",
        isError: true,
        durationMs: 120_000,
        outputBytes: 18,
        truncated: false,
        attempts: 1,
        failureCategory: "timeout",
        errorCode: "tool_timeout",
        permissionSource: "user",
      },
    } as const;
    expect(ToolFinishedEventSchema.parse(failure)).toEqual(failure);
    const { failureCategory: _category, ...incompletePayload } = failure.payload;
    expect(
      ToolFinishedEventSchema.safeParse({ ...failure, payload: incompletePayload }).success,
    ).toBe(false);
  });

  test("continues to parse persisted Stage2 retry and terminal events", () => {
    expect(
      ToolRetryingEventSchema.safeParse({
        ...eventBase,
        type: "tool.retrying",
        payload: {
          toolCallId: "call-old",
          name: "read_file",
          attempt: 2,
          maxAttempts: 2,
          delayMs: 50,
          errorCode: "io_error",
        },
      }).success,
    ).toBe(true);
    expect(
      ToolFinishedEventSchema.safeParse({
        ...eventBase,
        type: "tool.finished",
        payload: {
          toolCallId: "call-old",
          name: "read_file",
          isError: false,
          durationMs: 8,
          outputBytes: 42,
          truncated: false,
        },
      }).success,
    ).toBe(true);
  });
});
