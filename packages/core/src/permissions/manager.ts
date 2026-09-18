import { randomUUID } from "node:crypto";
import type {
  PermissionRespondParams,
  PermissionRespondResult,
  PermissionDecision,
} from "@minicode/protocol";
import type { EventBus } from "../events/event-bus.ts";
import { ToolError } from "../tools/types.ts";
import {
  evaluatePermission,
  permissionSummary,
  type PermissionCache,
  type PermissionOutcome,
  type PermissionScope,
} from "./policy.ts";

interface PendingRequest {
  readonly scope: PermissionScope;
  readonly cancel: () => void;
  readonly respond: (decision: PermissionDecision) => Promise<PermissionRespondResult>;
}

/** Core 生命周期内管理策略、session 缓存和可取消的审批 Promise；不持久化 always 决策。 */
export class PermissionManager {
  readonly #bus: EventBus;
  readonly #cache = new Map<string, PermissionCache>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #resolved = new Map<string, PermissionScope>();
  #closed = false;

  /** 保存持久事件总线；每个 Core 实例使用独立管理器。 */
  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  /** 参数校验后先执行强制策略，再查单风险缓存，最后挂起用户审批。 */
  async check(
    name: string,
    params: unknown,
    scope: PermissionScope,
    signal: AbortSignal,
  ): Promise<PermissionOutcome> {
    if (signal.aborted || this.#closed)
      throw new ToolError("tool_cancelled", "tool call cancelled");
    const policy = evaluatePermission(name, params);
    if (policy.decision !== "ask")
      return { allowed: policy.decision === "allow", source: "policy" };
    const risk = policy.cacheable
      ? name.startsWith("mcp__")
        ? name
        : policy.riskCategories[0]
      : undefined;
    const cached = risk === undefined ? undefined : this.#cache.get(scope.sessionId)?.get(risk);
    if (cached !== undefined) return { allowed: cached, source: "session_cache" };

    const id = randomUUID();
    let resolve!: (outcome: PermissionOutcome) => void;
    let reject!: (error: unknown) => void;
    const waiting = new Promise<PermissionOutcome>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void waiting.catch(() => {});
    // 先登记再发布，客户端收到事件后即可响应；失败仍由 check 向上层传播。
    let claimed = false;
    let ready: Promise<void>;
    const cleanup = (): void => {
      signal.removeEventListener("abort", cancel);
      this.#pending.delete(id);
      this.#resolved.set(id, scope);
    };
    const cancel = (): void => {
      if (claimed) return;
      claimed = true;
      void ready.then(
        () => {
          cleanup();
          // 取消由 tool.finished/run.finished 终态关闭审批，不伪造 user 决策。
          reject(new ToolError("tool_cancelled", "tool call cancelled"));
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    };
    this.#pending.set(id, {
      scope,
      cancel,
      respond: async (decision) => {
        if (claimed) return { outcome: "already_resolved" };
        if (risk === undefined && decision.startsWith("always_")) return { outcome: "not_found" };
        claimed = true; // 第一个合法响应同步占位，写盘期间不能被另一个连接覆盖。
        try {
          await ready;
          const allowed = decision === "allow_once" || decision === "always_allow";
          const published = await this.#bus.publish({
            ...scopeIds(scope),
            timestamp: new Date().toISOString(),
            durable: true,
            type: "permission.resolved",
            payload: {
              ...(scope.childRunId === undefined ? {} : { childRunId: scope.childRunId }),
              permissionRequestId: id,
              toolCallId: scope.toolCallId,
              name,
              decision,
              allowed,
              source: "user",
            },
          });
          if (!published.ok) throw new Error("permission resolution persistence failed");
          if (risk !== undefined && decision.startsWith("always_")) {
            let cache = this.#cache.get(scope.sessionId);
            if (cache === undefined) {
              cache = new Map();
              this.#cache.set(scope.sessionId, cache);
            }
            cache.set(risk, allowed);
          }
          cleanup();
          resolve({ allowed, source: "user" });
          return { outcome: "accepted" };
        } catch (error) {
          cleanup();
          reject(error);
          throw error;
        }
      },
    });
    ready = (async () => {
      const published = await this.#bus.publish({
        ...scopeIds(scope),
        timestamp: new Date().toISOString(),
        durable: true,
        type: "permission.requested",
        payload: {
          ...(scope.childRunId === undefined ? {} : { childRunId: scope.childRunId }),
          permissionRequestId: id,
          toolCallId: scope.toolCallId,
          name,
          riskCategories: [...policy.riskCategories],
          cacheable: policy.cacheable,
          summary: permissionSummary(name, params),
        },
      });
      if (!published.ok) throw new Error("permission request persistence failed");
    })();
    // 立即给 waiting 安装拒绝处理，避免取消/写盘失败与 await 之间的未处理拒绝。
    const result = ready.then(() => waiting);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted || this.#closed) cancel();
    try {
      return await result;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#pending.delete(id);
    }
  }

  /** 仅返回匹配 session/run 的记录，外国与未知 ID 统一隐藏为 not_found。 */
  async respond(params: PermissionRespondParams): Promise<PermissionRespondResult> {
    const pending = this.#pending.get(params.permissionRequestId);
    const scope = pending?.scope ?? this.#resolved.get(params.permissionRequestId);
    if (scope === undefined || scope.sessionId !== params.sessionId || scope.runId !== params.runId)
      return { outcome: "not_found" };
    return pending === undefined
      ? { outcome: "already_resolved" }
      : pending.respond(params.decision);
  }

  /** 关闭 admission 并取消所有挂起请求，供 Core 停机排空使用。 */
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.cancel();
    this.#cache.clear();
  }

  /** 暴露待审批数量，便于生命周期测试。 */
  get pendingCount(): number {
    return this.#pending.size;
  }
}

/** 从审批作用域中提取事件信封字段。 */
function scopeIds(scope: PermissionScope): { sessionId: string; runId: string } {
  return { sessionId: scope.sessionId, runId: scope.runId };
}
