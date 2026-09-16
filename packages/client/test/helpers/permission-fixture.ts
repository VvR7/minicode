import type { AgentEvent, PermissionDecision } from "@minicode/protocol";
import type { PermissionRequestedEvent } from "../../src/permission-state.ts";

export const permissionRequest: PermissionRequestedEvent = {
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  runId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  sequence: 1,
  timestamp: "2026-09-16T08:00:00.000Z",
  durable: true,
  type: "permission.requested",
  payload: {
    permissionRequestId: "950e8400-e29b-41d4-a716-446655440000",
    toolCallId: "write-1",
    name: "write",
    riskCategories: ["write"],
    cacheable: true,
    summary: {
      kind: "write",
      path: "file.txt",
      contentBytes: 5,
      previewStart: "hello",
      previewEnd: "hello",
    },
  },
};

/** 构造真实协议可校验的审批决策。 */
export function permissionResolved(
  request: PermissionRequestedEvent = permissionRequest,
  decision: PermissionDecision = "allow_once",
  sequence = 2,
): AgentEvent {
  return {
    ...request,
    sequence,
    type: "permission.resolved",
    payload: {
      permissionRequestId: request.payload.permissionRequestId,
      toolCallId: request.payload.toolCallId,
      name: request.payload.name,
      decision,
      allowed: decision === "allow_once" || decision === "always_allow",
      source: "user",
    },
  };
}

/** 构造真实协议可校验的 run 成功终态。 */
export function runFinished(
  request: PermissionRequestedEvent = permissionRequest,
  sequence = 3,
): AgentEvent {
  return {
    ...request,
    sequence,
    type: "run.finished",
    payload: {
      status: "succeeded",
      reason: "completed",
      finalText: "done",
      steps: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}
