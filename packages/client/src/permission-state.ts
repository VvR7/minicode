import type { AgentEvent, PermissionRequestId, RunId } from "@minicode/protocol";

export type PermissionRequestedEvent = Extract<AgentEvent, { type: "permission.requested" }>;
export type PermissionResolvedEvent = Extract<AgentEvent, { type: "permission.resolved" }>;

/** 只有 durable resolved 才代表用户决策；取消/过期不伪造审批结果。 */
export interface ClientPermission {
  readonly request: PermissionRequestedEvent;
  readonly status: "pending" | "resolved" | "closed";
  readonly resolution?: PermissionResolvedEvent;
}

/** CLI/TUI 共享审批投影；输入应已校验 session/run 归属。 */
export class PermissionState {
  #entries = new Map<PermissionRequestId, ClientPermission>();
  #cursors = new Map<RunId, number>();

  /** 返回不可修改的快照，不暴露内部 Map。 */
  get snapshot(): readonly ClientPermission[] {
    return [...this.#entries.values()];
  }

  /** 按 run cursor 去重，工具或 run 终态关闭遗留审批。 */
  apply(event: AgentEvent): boolean {
    if (event.sequence <= (this.#cursors.get(event.runId) ?? 0)) return false;
    this.#cursors.set(event.runId, event.sequence);
    if (event.type === "permission.requested") {
      const id = event.payload.permissionRequestId;
      if (this.#entries.has(id)) return false;
      this.#entries.set(id, { request: event, status: "pending" });
      return true;
    }
    if (event.type === "permission.resolved") {
      const id = event.payload.permissionRequestId;
      const entry = this.#entries.get(id);
      if (entry === undefined || entry.resolution !== undefined) return false;
      this.#entries.set(id, { request: entry.request, status: "resolved", resolution: event });
      return true;
    }
    if (event.type !== "tool.finished" && event.type !== "run.finished") return false;
    let changed = false;
    for (const [id, entry] of this.#entries) {
      if (
        entry.status === "pending" &&
        entry.request.runId === event.runId &&
        (event.type === "run.finished" ||
          entry.request.payload.toolCallId === event.payload.toolCallId)
      ) {
        this.#entries.set(id, { request: entry.request, status: "closed" });
        changed = true;
      }
    }
    return changed;
  }

  /** Core 已确认请求过期/已处理时，停止本地交互，仍等待 journal 的真实决策。 */
  close(id?: PermissionRequestId): boolean {
    let changed = false;
    for (const [key, entry] of this.#entries) {
      if (entry.status === "pending" && (id === undefined || key === id)) {
        this.#entries.set(key, { request: entry.request, status: "closed" });
        changed = true;
      }
    }
    return changed;
  }

  /** 会话切换时释放全部审批和 cursor，缓存决策始终由 Core 管理。 */
  clear(): void {
    this.#entries.clear();
    this.#cursors.clear();
  }
}
