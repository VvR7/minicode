import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ClientPermission, PermissionRequestedEvent } from "@minicode/client";
import type { PermissionDecision, PermissionRespondResult } from "@minicode/protocol";

export type PermissionPrompt = (
  request: PermissionRequestedEvent,
  signal: AbortSignal,
) => Promise<PermissionDecision>;

const choices: Readonly<Record<string, PermissionDecision>> = {
  "1": "allow_once",
  "2": "always_allow",
  "3": "deny_once",
  "4": "always_deny",
};

/** 只读终端输入并写交互流；摘要 JSON 转义控制字符，避免模型内容控制终端。 */
export function promptPermission(
  request: PermissionRequestedEvent,
  signal: AbortSignal,
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<PermissionDecision> {
  if (signal.aborted) return Promise.resolve("deny_once");
  return new Promise((resolve) => {
    const terminal = createInterface({ input, output, terminal: false });
    let settled = false;
    const finish = (decision: PermissionDecision): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      terminal.close();
      resolve(decision);
    };
    const onAbort = (): void => finish("deny_once");
    terminal.on("close", () => finish("deny_once"));
    terminal.on("line", (line) => {
      const decision = choices[line.trim()];
      if (
        decision === undefined ||
        (!request.payload.cacheable && decision.startsWith("always_"))
      ) {
        output.write(
          request.payload.cacheable
            ? "Choose 1, 2, 3 or 4: "
            : "Choose 1 or 3 (always unavailable): ",
        );
        return;
      }
      finish(decision);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    output.write(`\nPermission: ${JSON.stringify(request.payload.summary, null, 2)}\n`);
    if (request.payload.cacheable)
      output.write(
        `Always applies to this session's approval scope: ${request.payload.summary.kind === "mcp" ? request.payload.name : request.payload.riskCategories.join(", ")}\n`,
      );
    output.write(
      `1) allow once  2) always allow${request.payload.cacheable ? "" : " (unavailable)"}\n`,
    );
    output.write(
      `3) deny once   4) always deny${request.payload.cacheable ? "" : " (unavailable)"}\nChoose: `,
    );
  });
}

interface ApprovalQueueOptions {
  readonly prompt: PermissionPrompt;
  readonly respond: (
    request: PermissionRequestedEvent,
    decision: PermissionDecision,
  ) => Promise<PermissionRespondResult>;
  readonly write: (text: string) => void;
}

/** 审批交互异步运行，绝不占住事件 consumer；取消/他端决策立即撤销当前提示。 */
export class ApprovalQueue {
  #options: ApprovalQueueOptions;
  #permissions: readonly ClientPermission[] = [];
  #active: { id: string; controller: AbortController } | undefined;
  #connected = false;
  #closed = false;

  /** 注入终端提示、类型化响应及交互输出，便于无 TTY 测试。 */
  constructor(options: ApprovalQueueOptions) {
    this.#options = options;
  }

  /** 断线撤销输入，重新附着后的快照再启动交互，避免向旧连接发送决策。 */
  setConnected(connected: boolean): void {
    this.#connected = connected;
    if (!connected) this.#stopActive();
  }

  /** 消费权威投影；同一 pending 请求在一次连接内只提示一次。 */
  update(permissions: readonly ClientPermission[]): void {
    this.#permissions = permissions;
    if (
      this.#active !== undefined &&
      !permissions.some(
        (entry) =>
          entry.status === "pending" &&
          entry.request.payload.permissionRequestId === this.#active?.id,
      )
    )
      this.#stopActive();
    this.#pump();
  }

  /** run 结束或用户取消时停止全部交互，不发送伪造的 deny。 */
  close(): void {
    this.#closed = true;
    this.#stopActive();
  }

  /** 撤销当前终端输入，迟到的输入或 RPC 返回不会重启交互。 */
  #stopActive(): void {
    this.#active?.controller.abort();
    this.#active = undefined;
  }

  /** 串行挑选 pending 请求；accepted 仍等待 journal，不能乐观记为用户决策。 */
  #pump(): void {
    if (this.#closed || !this.#connected || this.#active !== undefined) return;
    const entry = this.#permissions.find((permission) => permission.status === "pending");
    if (entry === undefined) return;
    const active = {
      id: entry.request.payload.permissionRequestId,
      controller: new AbortController(),
    };
    this.#active = active;
    void this.#ask(entry.request, active.controller.signal).catch(() => {
      if (!active.controller.signal.aborted)
        this.#options.write("error: permission response failed; waiting for reconnect\n");
    });
  }

  /** 等待用户决策并发送，允许事件流同时处理 resolved、终态与断线。 */
  async #ask(request: PermissionRequestedEvent, signal: AbortSignal): Promise<void> {
    let decision: PermissionDecision;
    try {
      decision = await this.#options.prompt(request, signal);
    } catch {
      // 输入关闭/不可用按非交互语义拒绝；真正的取消不发送任何新决策。
      decision = "deny_once";
    }
    if (signal.aborted) return;
    if (!request.payload.cacheable && decision.startsWith("always_")) decision = "deny_once";
    const result = await this.#options.respond(request, decision);
    if (!signal.aborted && result.outcome !== "accepted")
      this.#options.write(`permission response: ${result.outcome}\n`);
  }
}
