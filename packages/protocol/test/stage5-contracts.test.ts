import { describe, expect, test } from "bun:test";

import {
  AgentEventSchema,
  EventPushNotificationSchema,
  ExtensionDiagnosticSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  PermissionRequestSummarySchema,
  PushedEventSchema,
  SkillDescriptionSchema,
  SkillListRequestSchema,
  SkillListResultSchema,
  SkillListSuccessResponseSchema,
  SubagentFinishedEventSchema,
  SubagentStartedEventSchema,
} from "../src/index.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const childRunId = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const eventBase = {
  sessionId,
  runId,
  sequence: 1,
  timestamp: "2026-09-18T08:00:00.000Z",
  durable: true,
} as const;

describe("Stage5 skill catalog contracts", () => {
  const skill = {
    name: "testing",
    description: "检查并运行项目测试",
    path: "/workspace/.minicode/skills/testing/SKILL.md",
  };

  test("supports workspace queries without creating a run and bounded file diagnostics", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: "skills-1",
      method: "skill.list" as const,
      params: { workspaceRoot: "/workspace" },
    };
    expect(SkillListRequestSchema.parse(request)).toEqual(request);
    const result = {
      skills: [skill],
      diagnostics: [
        { path: "/workspace/bad/SKILL.md", code: "invalid_skill", message: "缺少名称" },
      ],
    };
    expect(SkillListResultSchema.parse(result)).toEqual(result);
    const response = { jsonrpc: "2.0" as const, id: "skills-1", result };
    expect(SkillListSuccessResponseSchema.parse(response)).toEqual(response);
    expect(SkillListResultSchema.parse({ skills: [], diagnostics: [] })).toEqual({
      skills: [],
      diagnostics: [],
    });
  });

  test("rejects missing, excessive and unexpected catalog data", () => {
    for (const input of [
      { ...skill, name: "" },
      { ...skill, name: "x".repeat(129) },
      { ...skill, description: "" },
      { ...skill, description: "x".repeat(1025) },
      { ...skill, path: "x".repeat(4097) },
      { ...skill, body: "unrequested正文" },
    ]) {
      expect(SkillDescriptionSchema.safeParse(input).success).toBe(false);
    }
    expect(
      ExtensionDiagnosticSchema.safeParse({
        path: "/bad",
        code: "invalid",
        message: "x".repeat(1025),
      }).success,
    ).toBe(false);
    expect(SkillListResultSchema.safeParse({ skills: [skill] }).success).toBe(false);
    expect(
      SkillListRequestSchema.safeParse({
        jsonrpc: "2.0" as const,
        id: "skills-1",
        method: "skill.list" as const,
        params: { workspaceRoot: "/workspace", runId },
      }).success,
    ).toBe(false);
  });
});

describe("Stage5 subagent lifecycle contracts", () => {
  const identity = { childRunId, name: "planner", background: true };

  test("lifecycle events push on the parent run and require durable identity", () => {
    const started = { ...eventBase, type: "subagent.started" as const, payload: identity };
    expect(SubagentStartedEventSchema.parse(started)).toEqual(started);
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      const finished = {
        ...eventBase,
        type: "subagent.finished" as const,
        payload: { ...identity, status, summary: "子任务结果" },
      };
      expect(SubagentFinishedEventSchema.parse(finished)).toEqual(finished);
      for (const event of [started, finished]) {
        expect(AgentEventSchema.parse(event)).toEqual(event);
        expect(PushedEventSchema.parse(event)).toEqual(event);
        expect(
          EventPushNotificationSchema.safeParse({
            jsonrpc: "2.0" as const,
            method: "event.push",
            params: { subscriptionId: sessionId, event },
          }).success,
        ).toBe(true);
      }
    }
  });

  test("rejects missing parent scope, invalid child identity and excessive summaries", () => {
    const event = { ...eventBase, type: "subagent.started" as const, payload: identity };
    for (const bad of [
      { ...event, sessionId: undefined },
      { ...event, runId: undefined },
      { ...event, durable: false },
      { ...event, payload: { ...identity, childRunId: "foreign-child" } },
      { ...event, payload: { ...identity, background: undefined } },
      { ...event, payload: { ...identity, prompt: "private" } },
    ]) {
      expect(AgentEventSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      SubagentFinishedEventSchema.safeParse({
        ...eventBase,
        type: "subagent.finished" as const,
        payload: { ...identity, status: "running", summary: "" },
      }).success,
    ).toBe(false);
    expect(
      SubagentFinishedEventSchema.safeParse({
        ...eventBase,
        type: "subagent.finished" as const,
        payload: { ...identity, status: "failed", summary: "x".repeat(4097) },
      }).success,
    ).toBe(false);
  });
});

describe("Stage5 MCP and child permission contracts", () => {
  const summary = {
    kind: "mcp" as const,
    server: "docs",
    tool: "search",
    paramsPreview: '{"query":"test","token":"[REDACTED]"}',
  };
  const requested = {
    ...eventBase,
    type: "permission.requested" as const,
    payload: {
      permissionRequestId: sessionId,
      toolCallId: "child-call-1",
      name: "mcp__docs__search",
      childRunId,
      riskCategories: ["mcp" as const],
      cacheable: true,
      summary,
    },
  };

  test("accepts bounded MCP summary and child metadata without changing the response scope", () => {
    expect(PermissionRequestSummarySchema.parse(summary)).toEqual(summary);
    expect(PermissionRequestedEventSchema.parse(requested)).toEqual(requested);
    const resolved = {
      ...eventBase,
      type: "permission.resolved" as const,
      payload: {
        permissionRequestId: sessionId,
        toolCallId: "child-call-1",
        name: "mcp__docs__search",
        childRunId,
        decision: "allow_once" as const,
        allowed: true,
        source: "user" as const,
      },
    };
    expect(PermissionResolvedEventSchema.parse(resolved)).toEqual(resolved);
    expect(
      PermissionResolvedEventSchema.safeParse({
        ...resolved,
        payload: { ...resolved.payload, childRunId: "invalid" },
      }).success,
    ).toBe(false);
  });

  test("rejects raw/oversized MCP parameters and malformed child identity", () => {
    for (const bad of [
      { ...summary, paramsPreview: "x".repeat(1025) },
      { ...summary, params: { token: "secret" } },
      { ...summary, server: "" },
    ]) {
      expect(PermissionRequestSummarySchema.safeParse(bad).success).toBe(false);
    }
    expect(
      PermissionRequestedEventSchema.safeParse({
        ...requested,
        payload: { ...requested.payload, childRunId: "invalid" },
      }).success,
    ).toBe(false);
  });
});
