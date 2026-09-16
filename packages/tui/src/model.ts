import type { SessionControllerEvent, SessionControllerStatus } from "@minicode/client";
import { type ClientPermission, PermissionState } from "@minicode/client";
import type {
  AgentEvent,
  HistoryContent,
  HistoryTurn,
  PermissionDecision,
  SessionSummary,
  TaskSnapshot,
} from "@minicode/protocol";
import { allowedChoices, formatPermissionBlock } from "./widgets/permission-block.ts";

/** 会话运行阶段；cancelling 表示已发取消请求但尚未收到权威终态。 */
export type RunState = "idle" | "running" | "cancelling";
/** 日志语义决定稳定标签和颜色；关闭颜色后仍能由文字识别。 */
export type LogKind =
  | "you"
  | "assistant"
  | "turn"
  | "task-pending"
  | "task-running"
  | "task-completed"
  | "task-blocked"
  | "tool"
  | "tool-retry"
  | "tool-error"
  | "model"
  | "retry"
  | "usage"
  | "error"
  | "info";
/** 一条可增量更新的 transcript 行。 */
export interface LogLine {
  readonly id: number;
  readonly kind: LogKind;
  readonly text: string;
  /** Assistant Markdown 正在接收 delta 时保持流式解析。 */
  readonly streaming?: boolean;
}
/** EventLog 执行的最小增量变更。 */
export type LogMutation =
  | { readonly type: "append"; readonly line: LogLine }
  | { readonly type: "update"; readonly line: LogLine }
  | { readonly type: "remove"; readonly ids: readonly number[] };
/** TUI 状态快照。 */
export interface TuiSnapshot {
  readonly connection: SessionControllerStatus;
  readonly run: RunState;
  readonly session: SessionSummary | undefined;
  readonly activeRunId: string | undefined;
  readonly readOnly: boolean;
  readonly lines: readonly LogLine[];
  readonly notice: string | undefined;
  readonly model: string | undefined;
  readonly contextUsedTokens: number | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly permission: ClientPermission | undefined;
  readonly permissionSelection: PermissionDecision;
}

export const MAX_LOG_LINES = 1000;
export const MAX_LOG_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** 截取 UUID 前八位，避免窄终端状态栏溢出。 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
/** 返回任务的文字状态；blocked 优先于存储状态。 */
export function taskDisplayStatus(
  task: TaskSnapshot,
): "pending" | "in_progress" | "completed" | "blocked" {
  return task.blocked ? "blocked" : task.status;
}

/** 把历史内容块压缩为可审计文字。 */
function historyBlock(block: HistoryContent): { kind: LogKind; text: string } {
  if (block.type === "text") return { kind: "assistant", text: `[ASSISTANT] ${block.text}` };
  if (block.type === "tool_use")
    return { kind: "tool", text: `[TOOL] ▶ running ${block.name} ${JSON.stringify(block.input)}` };
  return {
    kind: block.isError ? "tool-error" : "tool",
    text: `[TOOL] ${block.isError ? "✗ failed" : "✓ completed"} ${block.content}`,
  };
}

/**
 * 多轮展示归约器：以 turn/run identity 与 event sequence 去重，维护 transcript
 * 和会话忙闲状态，不以显示文本作为去重依据。
 */
export class TuiModel {
  #connection: SessionControllerStatus = "connecting";
  #run: RunState = "idle";
  #session: SessionSummary | undefined;
  #activeRunId: string | undefined;
  #readOnly = false;
  #lines: LogLine[] = [];
  #notice: string | undefined;
  #model: string | undefined;
  #contextUsedTokens: number | undefined;
  #contextWindowTokens: number | undefined;
  #nextId = 1;
  #bytes = 0;
  #maxLines: number;
  #maxBytes: number;
  #knownTurns = new Set<string>();
  #runSequences = new Map<string, number>();
  /** 每个 run 当前 step 正在流式输出的 assistant 块；新 step 必须另起一块以保持事件顺序。 */
  #assistantLines = new Map<string, number>();
  #turnLines = new Map<string, number>();
  #taskLines = new Map<string, number>();
  #permissions = new PermissionState();
  #permissionLines = new Map<string, number>();
  #permissionSelection: PermissionDecision = "allow_once";
  #permissionSending = new Set<string>();
  #permissionErrors = new Map<string, string>();

  /** 测试可注入更小的 transcript 上限。 */
  constructor(
    options: {
      readonly maxLines?: number;
      readonly maxBytes?: number;
      readonly model?: string;
      readonly contextWindowTokens?: number;
    } = {},
  ) {
    this.#maxLines = options.maxLines ?? MAX_LOG_LINES;
    this.#maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.#model = options.model;
    this.#contextWindowTokens = options.contextWindowTokens;
  }
  /** 返回当前不可变快照。 */
  snapshot(): TuiSnapshot {
    return {
      connection: this.#connection,
      run: this.#run,
      session: this.#session,
      activeRunId: this.#activeRunId,
      readOnly: this.#readOnly,
      lines: this.#lines,
      notice: this.#notice,
      model: this.#model,
      contextUsedTokens: this.#contextUsedTokens,
      contextWindowTokens: this.#contextWindowTokens,
      permission: this.#permissions.snapshot.find((entry) => entry.status === "pending"),
      permissionSelection: this.#permissionSelection,
    };
  }

  /** 切换 session 前清空会话状态，防止 transcript 泄漏。 */
  reset(readOnly = false): readonly LogMutation[] {
    const removed = this.#lines.map((line) => line.id);
    this.#run = "idle";
    this.#session = undefined;
    this.#activeRunId = undefined;
    this.#readOnly = readOnly;
    this.#lines = [];
    this.#bytes = 0;
    this.#notice = undefined;
    this.#contextUsedTokens = undefined;
    this.#knownTurns.clear();
    this.#runSequences.clear();
    this.#assistantLines.clear();
    this.#turnLines.clear();
    this.#taskLines.clear();
    this.#permissions.clear();
    this.#permissionLines.clear();
    this.#permissionSending.clear();
    this.#permissionErrors.clear();
    this.#permissionSelection = "allow_once";
    return removed.length === 0 ? [] : [{ type: "remove", ids: removed }];
  }
  /** 设置本地提示。 */
  setNotice(message: string | undefined): void {
    this.#notice = message;
  }
  /** 标记取消中，阻止重复取消 RPC。 */
  markCancelling(): void {
    if (this.#run === "running") this.#run = "cancelling";
  }

  /** 同步 controller 的共享投影；重连后保留未决审批，终态不伪造决策。 */
  syncPermissions(entries: readonly ClientPermission[]): readonly LogMutation[] {
    const mutations: LogMutation[] = [];
    for (const entry of entries) {
      this.#permissions.apply(entry.request);
      if (entry.resolution !== undefined) this.#permissions.apply(entry.resolution);
      else if (entry.status === "closed")
        this.#permissions.close(entry.request.payload.permissionRequestId);
    }
    this.#renderPermissions(mutations);
    return mutations;
  }

  /** 移动审批焦点，只循环可用选项，不提交请求。 */
  movePermission(delta: number): readonly LogMutation[] {
    const permission = this.snapshot().permission;
    if (permission === undefined) return [];
    const choices = allowedChoices(permission);
    this.#permissionSelection =
      choices[
        (choices.indexOf(this.#permissionSelection) + delta + choices.length) % choices.length
      ] ?? "allow_once";
    const mutations: LogMutation[] = [];
    this.#renderPermissions(mutations);
    return mutations;
  }

  /** 标记正在发送，防止重复按键；只有权威事件才能结束审批。 */
  beginPermission(decision: PermissionDecision): ClientPermission | undefined {
    const permission = this.snapshot().permission;
    if (
      permission === undefined ||
      this.#run === "cancelling" ||
      this.#connection !== "connected" ||
      !allowedChoices(permission).includes(decision)
    )
      return undefined;
    const id = permission.request.payload.permissionRequestId;
    if (this.#permissionSending.has(id)) return undefined;
    this.#permissionSelection = decision;
    this.#permissionSending.add(id);
    this.#permissionErrors.delete(id);
    return permission;
  }

  /** 发送失败或 Core 判定过期时释放交互；accepted 继续等待 journal。 */
  finishPermission(id: string, outcome?: string, error?: string): readonly LogMutation[] {
    if (outcome !== "accepted") this.#permissionSending.delete(id);
    if (outcome === "already_resolved" || outcome === "not_found") this.#permissions.close(id);
    if (error !== undefined) this.#permissionErrors.set(id, error);
    const mutations: LogMutation[] = [];
    this.#renderPermissions(mutations);
    return mutations;
  }

  /** 按审批 identity 更新同一内联块，不随 replay 追加重复行。 */
  #renderPermissions(mutations: LogMutation[]): void {
    const active = this.snapshot().permission;
    if (active !== undefined && !allowedChoices(active).includes(this.#permissionSelection))
      this.#permissionSelection = "allow_once";
    for (const entry of this.#permissions.snapshot) {
      const key = entry.request.payload.permissionRequestId;
      const text = formatPermissionBlock(
        entry,
        this.#permissionSelection,
        this.#permissionSending.has(key),
        this.#permissionErrors.get(key),
      );
      const id = this.#permissionLines.get(key);
      if (id === undefined) this.#permissionLines.set(key, this.#append(mutations, "info", text));
      else this.#replace(mutations, id, "info", text);
    }
  }

  /** 应用 SessionController 的已校验事件。 */
  apply(event: SessionControllerEvent): readonly LogMutation[] {
    const mutations: LogMutation[] = [];
    if (event.type === "controller.status") {
      this.#connection = event.status;
      if (event.status !== "connected") this.#permissionSending.clear();
    } else if (event.type === "session.attached") {
      this.#session = event.session;
      this.#readOnly = event.session.mode === "one_shot" || event.session.status === "corrupted";
      this.#run = event.session.status === "running" ? "running" : "idle";
      this.#activeRunId = event.session.activeRun?.runId;
    } else if (event.type === "turn.snapshot") this.#applyHistory(event.turn, mutations);
    else if (event.type === "turn.accepted") {
      if (!this.#knownTurns.has(event.turnId)) {
        this.#knownTurns.add(event.turnId);
        this.#append(mutations, "you", `[YOU] ${event.userMessage}`);
        this.#turnLines.set(
          event.runId,
          this.#append(mutations, "turn", `[TURN] ● running ${shortId(event.runId)}`),
        );
      }
      this.#run = "running";
      this.#activeRunId = event.runId;
    } else if (event.type === "run.event") this.#applyRunEvent(event.event, mutations);
    else this.#finishTurn(event.runId, event.status, event.reason, mutations);
    return mutations;
  }

  /** 添加明确的错误行。 */
  addError(message: string): readonly LogMutation[] {
    const mutations: LogMutation[] = [];
    this.#append(mutations, "error", `[ERROR] ${message}`);
    return mutations;
  }

  /** 展开持久历史 turn，并将任务图保持默认折叠。 */
  #applyHistory(turn: HistoryTurn, mutations: LogMutation[]): void {
    if (this.#knownTurns.has(turn.turnId)) return;
    this.#knownTurns.add(turn.turnId);
    for (const message of turn.messages) {
      if (message.role === "user") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        this.#append(mutations, "you", `[YOU] ${text}`);
      } else
        for (const block of message.content) {
          const formatted = historyBlock(block);
          this.#append(mutations, formatted.kind, formatted.text);
        }
    }
    const symbol =
      turn.status === "running"
        ? "●"
        : turn.status === "succeeded"
          ? "✓"
          : turn.status === "cancelled"
            ? "⊘"
            : "✗";
    this.#turnLines.set(
      turn.runId,
      this.#append(
        mutations,
        "turn",
        `[TURN] ${symbol} ${turn.status} ${shortId(turn.runId)}${turn.reason === undefined ? "" : ` (${turn.reason})`}`,
      ),
    );
    if (turn.taskGraph !== undefined)
      this.#append(
        mutations,
        "info",
        `[TASK] ▸ run ${shortId(turn.runId)} — ${turn.taskGraph.tasks.length} tasks (collapsed)`,
      );
    if (turn.status === "running") {
      this.#run = "running";
      this.#activeRunId = turn.runId;
    }
  }

  /** 归约 run journal，并按 sequence 丢弃重复重放。 */
  #applyRunEvent(event: AgentEvent, mutations: LogMutation[]): void {
    if (event.sequence <= (this.#runSequences.get(event.runId) ?? 0)) return;
    this.#runSequences.set(event.runId, event.sequence);
    if (this.#permissions.apply(event)) this.#renderPermissions(mutations);
    switch (event.type) {
      case "run.started":
        this.#run = "running";
        this.#activeRunId = event.runId;
        break;
      case "step.started":
        // 一次 run 可能经历多次 LLM -> 工具调用；不能把后续 step 的最终回答写回工具前的旧块。
        this.#assistantLines.delete(event.runId);
        break;
      case "llm.text_delta": {
        let id = this.#assistantLines.get(event.runId);
        if (id === undefined) {
          id = this.#append(mutations, "assistant", "[ASSISTANT] ", true);
          this.#assistantLines.set(event.runId, id);
        }
        this.#extend(mutations, id, event.payload.text);
        break;
      }
      case "llm.model_selected":
        this.#model = event.payload.model;
        break;
      case "llm.retrying":
        this.#append(
          mutations,
          "retry",
          `[RETRY] ${event.payload.attempt}/${event.payload.maxAttempts} ${event.payload.reason}`,
        );
        break;
      case "llm.usage":
        this.#contextUsedTokens =
          event.payload.inputTokens +
          event.payload.cacheReadInputTokens +
          event.payload.cacheCreationInputTokens +
          event.payload.outputTokens;
        if (event.payload.contextWindowTokens !== undefined)
          this.#contextWindowTokens = event.payload.contextWindowTokens;
        break;
      case "tool.started":
        this.#append(mutations, "tool", `[TOOL] ▶ running ${event.payload.name}`);
        break;
      case "tool.retrying":
        this.#append(
          mutations,
          "tool-retry",
          `[TOOL] ↻ retry ${event.payload.name} ${event.payload.attempt}/${event.payload.maxAttempts}`,
        );
        break;
      case "tool.finished":
        this.#append(
          mutations,
          event.payload.isError ? "tool-error" : "tool",
          `[TOOL] ${event.payload.isError ? "✗ failed" : "✓ completed"} ${event.payload.name}`,
        );
        break;
      case "task.created":
      case "task.updated":
        this.#applyTask(event.runId, event.payload.task, mutations);
        break;
      case "run.finished":
        this.#correctFinalText(event.runId, event.payload.finalText, mutations);
        this.#finishTurn(event.runId, event.payload.status, event.payload.reason, mutations);
        break;
      case "step.finished":
        break;
    }
  }

  /** 实时任务按 run/task 稳定更新同一行。 */
  #applyTask(runId: string, task: TaskSnapshot, mutations: LogMutation[]): void {
    const status = taskDisplayStatus(task);
    const kind: LogKind =
      status === "blocked"
        ? "task-blocked"
        : status === "in_progress"
          ? "task-running"
          : status === "completed"
            ? "task-completed"
            : "task-pending";
    const symbol =
      status === "completed"
        ? "✓"
        : status === "in_progress"
          ? "●"
          : status === "blocked"
            ? "!"
            : "○";
    const text = `[TASK] ${symbol} ${status} #${task.id} ${task.subject}`;
    const key = `${runId}:${task.id}`;
    const id = this.#taskLines.get(key);
    if (id === undefined) this.#taskLines.set(key, this.#append(mutations, kind, text));
    else this.#replace(mutations, id, kind, text);
  }
  /** finalText 是权威值：替换流式块而不重复全文。 */
  #correctFinalText(runId: string, finalText: string, mutations: LogMutation[]): void {
    const id = this.#assistantLines.get(runId);
    if (id === undefined) {
      if (finalText.length > 0)
        this.#assistantLines.set(
          runId,
          this.#append(mutations, "assistant", `[ASSISTANT] ${finalText}`, false),
        );
    } else this.#replace(mutations, id, "assistant", `[ASSISTANT] ${finalText}`, false);
  }
  /** 应用权威终态并更新原 TURN 行。 */
  #finishTurn(
    runId: string,
    status: string,
    reason: string | undefined,
    mutations: LogMutation[],
  ): void {
    for (const entry of this.#permissions.snapshot)
      if (entry.request.runId === runId)
        this.#permissions.close(entry.request.payload.permissionRequestId);
    this.#renderPermissions(mutations);
    const symbol = status === "succeeded" ? "✓" : status === "cancelled" ? "⊘" : "✗";
    const text = `[TURN] ${symbol} ${status} ${shortId(runId)}${reason === undefined ? "" : ` (${reason})`}`;
    const id = this.#turnLines.get(runId);
    if (id === undefined) this.#turnLines.set(runId, this.#append(mutations, "turn", text));
    else this.#replace(mutations, id, "turn", text);
    if (this.#activeRunId === runId) {
      this.#run = "idle";
      this.#activeRunId = undefined;
    }
  }
  /** 追加日志并执行双重上限裁剪。 */
  #append(mutations: LogMutation[], kind: LogKind, text: string, streaming?: boolean): number {
    const line = {
      id: this.#nextId++,
      kind,
      text,
      ...(streaming === undefined ? {} : { streaming }),
    };
    this.#lines.push(line);
    this.#bytes += encoder.encode(text).length;
    mutations.push({ type: "append", line });
    this.#trim(mutations);
    return line.id;
  }
  /** 追加流式文本。 */
  #extend(mutations: LogMutation[], id: number, text: string): void {
    const line = this.#lines.find((candidate) => candidate.id === id);
    if (line !== undefined && text.length > 0)
      this.#replace(mutations, id, line.kind, line.text + text, line.streaming);
  }
  /** 替换稳定日志行。 */
  #replace(
    mutations: LogMutation[],
    id: number,
    kind: LogKind,
    text: string,
    streaming?: boolean,
  ): void {
    const index = this.#lines.findIndex((line) => line.id === id);
    const old = this.#lines[index];
    if (old === undefined) return;
    const line = { id, kind, text, ...(streaming === undefined ? {} : { streaming }) };
    this.#lines[index] = line;
    this.#bytes += encoder.encode(text).length - encoder.encode(old.text).length;
    mutations.push({ type: "update", line });
    this.#trim(mutations);
  }
  /** 淘汰最旧日志，避免长会话无限占用内存。 */
  #trim(mutations: LogMutation[]): void {
    const removed: number[] = [];
    while (this.#lines.length > this.#maxLines || this.#bytes > this.#maxBytes) {
      const line = this.#lines.shift();
      if (line === undefined) break;
      this.#bytes -= encoder.encode(line.text).length;
      removed.push(line.id);
    }
    if (removed.length > 0) mutations.push({ type: "remove", ids: removed });
  }
}
