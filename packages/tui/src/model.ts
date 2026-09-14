import type { AgentEvent } from "@minicode/protocol";
import type { AgentRunClientResult, AgentRunClientStatus } from "@minicode/client";

/** 连接阶段，来自共享客户端的状态回调。 */
export type ConnectionPhase = "connecting" | "connected" | "disconnected" | "cancelling";

/** run 的终态结果，来自 run.finished 事件。 */
export type RunOutcome = "succeeded" | "failed" | "cancelled";

/** run 的运行阶段。 */
export type RunState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "finished"; readonly outcome: RunOutcome }
  | {
      readonly status: "client-error";
      readonly kind: "connect-failed" | "acceptance-uncertain" | "internal-error";
    };

/** 日志行的语义类别，供渲染层决定颜色，模型层不感知终端样式。 */
export type LogKind =
  | "assistant"
  | "info"
  | "client-error"
  | "model"
  | "tool"
  | "tool-error"
  | "retry"
  | "usage"
  | "run-ok"
  | "run-fail";

/** 一条展示日志：id 稳定，便于增量更新与裁剪。 */
export interface LogLine {
  readonly id: number;
  readonly kind: LogKind;
  readonly text: string;
}

/** 模型只读快照，供状态栏与测试读取。 */
export interface TuiSnapshot {
  readonly connection: ConnectionPhase;
  readonly run: RunState;
  readonly sessionId: string | undefined;
  readonly runId: string | undefined;
  readonly lines: readonly LogLine[];
}

/** 事件应用到日志后的增量变更，渲染层据此更新对应的终端组件。 */
export type LogMutation =
  | { readonly type: "append"; readonly line: LogLine }
  | { readonly type: "update"; readonly line: LogLine }
  | { readonly type: "remove"; readonly ids: readonly number[] };

/** 展示模型的内存上限：逻辑行数与 UTF-8 字节数，超出后淘汰最旧行。 */
export const MAX_LOG_LINES = 1000;
export const MAX_LOG_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 从 UTF-8 文本尾部保留不超过 maxBytes 的完整字符。 */
function truncateUtf8Tail(text: string, maxBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) {
    return text;
  }
  if (maxBytes <= 0) {
    return "";
  }
  let start = encoded.length - maxBytes;
  while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return decoder.decode(encoded.subarray(start));
}

/** 截取 UUID 前 8 位用于状态栏等窄空间展示。 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 把 run 状态映射为进程退出码：succeeded=0、failed=1、用户取消=130。 */
export function exitCodeForRunState(run: RunState): number {
  if (run.status === "finished") {
    switch (run.outcome) {
      case "succeeded":
        return 0;
      case "failed":
        return 1;
      case "cancelled":
        return 130;
    }
  }
  if (run.status === "client-error") {
    return run.kind === "internal-error" ? 1 : 2;
  }
  // run 尚未建立或仍在运行中退出，按用户中断处理。
  return 130;
}

/** 按下退出键（q / Ctrl-C）时的决策。 */
export type QuitDecision =
  | { readonly action: "quit"; readonly code: number }
  | { readonly action: "cancel" };

/**
 * 根据当前 run 状态与是否已请求取消，决定退出键是直接退出还是先取消。
 * 终态直接退出；运行中首次触发取消、再次触发强制退出；未建立 run 直接退出。
 */
export function decideQuit(run: RunState, cancelRequested: boolean): QuitDecision {
  if (run.status === "finished" || run.status === "client-error") {
    return { action: "quit", code: exitCodeForRunState(run) };
  }
  if (cancelRequested) {
    return { action: "quit", code: 130 };
  }
  if (run.status === "running") {
    return { action: "cancel" };
  }
  return { action: "quit", code: 130 };
}

/**
 * 纯展示模型：把已校验归属、已去重的领域事件归约为日志行与运行状态。
 * 不依赖任何终端框架，便于单元测试覆盖全部事件 variant 与裁剪边界。
 */
export class TuiModel {
  #connection: ConnectionPhase = "connecting";
  #run: RunState = { status: "idle" };
  #sessionId: string | undefined;
  #runId: string | undefined;
  #lines: LogLine[] = [];
  #nextId = 1;
  #assistantLineId: number | undefined;
  #totalBytes = 0;
  #maxLines: number;
  #maxBytes: number;

  /** 内存上限默认取全局常量，测试可注入更小值以覆盖裁剪边界。 */
  constructor(options: { readonly maxLines?: number; readonly maxBytes?: number } = {}) {
    this.#maxLines = options.maxLines ?? MAX_LOG_LINES;
    this.#maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  }

  /** 返回当前状态的不可变视图。 */
  snapshot(): TuiSnapshot {
    return {
      connection: this.#connection,
      run: this.#run,
      sessionId: this.#sessionId,
      runId: this.#runId,
      lines: this.#lines,
    };
  }

  /** 应用连接状态回调：更新连接阶段，不写入日志。 */
  applyStatus(status: AgentRunClientStatus): void {
    this.#connection = status.state;
  }

  /**
   * 应用客户端生命周期结果：终态事件已处理时保持原状态；否则把取消或错误
   * 收敛为可退出状态，并给日志添加可见原因。
   */
  applyClientResult(result: AgentRunClientResult): readonly LogMutation[] {
    if (result.kind === "finished" || this.#run.status === "finished") {
      return [];
    }
    const mutations: LogMutation[] = [];
    if (result.kind === "cancelled") {
      this.#run = { status: "finished", outcome: "cancelled" };
      this.#append(mutations, "run-fail", "run cancelled (client shutdown or timeout)");
      return mutations;
    }
    this.#run = { status: "client-error", kind: result.kind };
    this.#append(mutations, "client-error", `client ${result.kind}`);
    return mutations;
  }

  /**
   * 应用一条领域事件，返回渲染层应执行的增量变更。
   * assistant 文本累积到当前 step 的同一行；其余事件各追加一行。
   */
  applyEvent(event: AgentEvent): readonly LogMutation[] {
    const mutations: LogMutation[] = [];
    switch (event.type) {
      case "run.started":
        this.#sessionId = event.sessionId;
        this.#runId = event.runId;
        this.#run = { status: "running" };
        this.#assistantLineId = undefined;
        this.#append(mutations, "info", `run ${event.runId}`);
        break;
      case "llm.model_selected":
        this.#append(
          mutations,
          "model",
          `model ${event.payload.model} (${event.payload.provider})`,
        );
        break;
      case "llm.text_delta": {
        if (this.#assistantLineId === undefined) {
          this.#assistantLineId = this.#append(mutations, "assistant", "");
        }
        this.#extend(mutations, this.#assistantLineId, event.payload.text);
        break;
      }
      case "llm.retrying":
        this.#append(
          mutations,
          "retry",
          `retrying ${event.payload.attempt}/${event.payload.maxAttempts} (${event.payload.reason})`,
        );
        break;
      case "llm.usage":
        this.#append(
          mutations,
          "usage",
          `usage in=${event.payload.inputTokens} out=${event.payload.outputTokens}`,
        );
        break;
      case "step.started":
        // 新 step 开始：结束上一 step 的 assistant 行，开启新的空 assistant 行。
        this.#assistantLineId = undefined;
        this.#append(mutations, "info", `step ${event.payload.step}`);
        break;
      case "step.finished":
        this.#append(mutations, "info", `step ${event.payload.step} ${event.payload.outcome}`);
        break;
      case "tool.started":
        this.#append(mutations, "tool", `tool ${event.payload.name}`);
        break;
      case "tool.retrying":
        this.#append(
          mutations,
          "retry",
          `tool ${event.payload.name} retrying ${event.payload.attempt}/${event.payload.maxAttempts}`,
        );
        break;
      case "tool.finished":
        this.#append(
          mutations,
          event.payload.isError ? "tool-error" : "tool",
          `tool ${event.payload.name} ${event.payload.isError ? "error" : "done"} ${event.payload.outputBytes}B${event.payload.truncated ? " (truncated)" : ""}`,
        );
        break;
      case "run.finished": {
        this.#run = { status: "finished", outcome: event.payload.status };
        this.#fillFinalText(mutations, event.payload.finalText);
        this.#append(
          mutations,
          event.payload.status === "succeeded" ? "run-ok" : "run-fail",
          `run ${event.payload.status} (${event.payload.reason})`,
        );
        this.#assistantLineId = undefined;
        break;
      }
    }
    return mutations;
  }

  /** run.finished 时用 durable finalText 校正当前 assistant 行。 */
  #fillFinalText(mutations: LogMutation[], finalText: string): void {
    if (this.#assistantLineId !== undefined) {
      const current = this.#lineText(this.#assistantLineId);
      if (finalText.startsWith(current)) {
        this.#extend(mutations, this.#assistantLineId, finalText.slice(current.length));
      } else {
        // 非持久 delta 可能在断线期间丢失；非前缀时必须用权威 finalText 整行替换。
        this.#replace(mutations, this.#assistantLineId, finalText);
      }
      return;
    }
    // 断线重放等场景：没有当前 assistant 行时，直接以 finalText 新建一行。
    if (finalText.length > 0) {
      this.#append(mutations, "assistant", finalText);
    }
  }

  /** 追加一行并返回其稳定 id。 */
  #append(mutations: LogMutation[], kind: LogKind, text: string): number {
    const line: LogLine = { id: this.#nextId, kind, text };
    this.#nextId += 1;
    this.#lines.push(line);
    this.#totalBytes += byteLength(text);
    mutations.push({ type: "append", line });
    this.#trim(mutations);
    return line.id;
  }

  /** 向已有行追加文本（assistant 流式增量），并发出 update 变更。 */
  #extend(mutations: LogMutation[], id: number, delta: string): void {
    if (delta.length === 0) {
      return;
    }
    const index = this.#lines.findIndex((line) => line.id === id);
    const current = this.#lines[index];
    if (current === undefined) {
      return;
    }
    const updated: LogLine = { ...current, text: current.text + delta };
    this.#lines[index] = updated;
    this.#totalBytes += byteLength(delta);
    mutations.push({ type: "update", line: updated });
    this.#trim(mutations);
  }

  /** 用权威文本替换已有行，并重新执行字节上限裁剪。 */
  #replace(mutations: LogMutation[], id: number, text: string): void {
    const index = this.#lines.findIndex((line) => line.id === id);
    const current = this.#lines[index];
    if (current === undefined) {
      return;
    }
    const updated: LogLine = { ...current, text };
    this.#lines[index] = updated;
    this.#totalBytes += byteLength(text) - byteLength(current.text);
    mutations.push({ type: "update", line: updated });
    this.#trim(mutations);
  }

  /** 超出内存上限时，从最旧的非当前 assistant 行开始淘汰。 */
  #trim(mutations: LogMutation[]): void {
    while (
      (this.#lines.length > this.#maxLines || this.#totalBytes > this.#maxBytes) &&
      this.#lines.length > 0
    ) {
      const index = this.#lines.findIndex((line) => line.id !== this.#assistantLineId);
      if (index === -1) {
        // 只剩当前 assistant 行时保留最新尾部，仍严格满足总字节上限。
        const assistantIndex = this.#lines.findIndex((line) => line.id === this.#assistantLineId);
        const assistant = this.#lines[assistantIndex];
        if (assistant === undefined) {
          return;
        }
        const text = truncateUtf8Tail(assistant.text, this.#maxBytes);
        this.#totalBytes += byteLength(text) - byteLength(assistant.text);
        const updated: LogLine = { ...assistant, text };
        this.#lines[assistantIndex] = updated;
        mutations.push({ type: "update", line: updated });
        return;
      }
      const [removed] = this.#lines.splice(index, 1);
      if (removed === undefined) {
        return;
      }
      this.#totalBytes -= byteLength(removed.text);
      mutations.push({ type: "remove", ids: [removed.id] });
    }
  }

  /** 读取指定 id 行的当前文本。 */
  #lineText(id: number): string {
    return this.#lines.find((line) => line.id === id)?.text ?? "";
  }
}
