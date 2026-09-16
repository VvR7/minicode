import type { PermissionRequestSummary, PermissionRiskCategory } from "@minicode/protocol";
import { classifyBashCommand, type BashPolicyResult } from "../tools/bash-policy.ts";

/** 仅对已通过工具 schema 校验的参数做纯策略判断，不访问缓存或文件系统。 */
export function evaluatePermission(name: string, params: unknown): BashPolicyResult {
  if (name === "bash") return classifyBashCommand((params as { command: string }).command);
  if (name === "write" || name === "edit") {
    return { decision: "ask", riskCategories: [name], cacheable: true };
  }
  // 注册表已拒绝未知工具；只读与任务、笔记工具保持原有自动允许语义。
  return { decision: "allow", riskCategories: [], cacheable: false };
}

/** 生成有界审批展示信息，避免完整文件内容进入持久事件。 */
export function permissionSummary(name: string, params: unknown): PermissionRequestSummary {
  const data = params as {
    command: string;
    timeout?: number;
    path: string;
    content: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  };
  if (name === "bash") {
    return {
      kind: "bash",
      command: data.command,
      timeoutSeconds: data.timeout ?? 120,
    };
  }
  const path = data.path;
  if (name === "write") {
    const content = data.content;
    return {
      kind: "write",
      path,
      contentBytes: new TextEncoder().encode(content).byteLength,
      previewStart: content.slice(0, 1024),
      previewEnd: content.slice(-1024),
    };
  }
  if (name === "edit") {
    return {
      kind: "edit",
      path,
      oldTextPreview: data.oldText.slice(0, 1024),
      newTextPreview: data.newText.slice(0, 1024),
      replaceAll: data.replaceAll === true,
    };
  }
  throw new Error("approval summary unavailable for tool");
}

export interface PermissionOutcome {
  readonly allowed: boolean;
  readonly source: "policy" | "session_cache" | "user";
}

export interface PermissionScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export type PermissionCache = Map<PermissionRiskCategory, boolean>;
