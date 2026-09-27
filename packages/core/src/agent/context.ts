import type { RunId, SessionId } from "@minicode/protocol";
import type { LlmContentPart, LlmMessage, LlmUsage } from "../llm/types.ts";

import type { ContextEntry } from "../compact/types.ts";
import { toProviderMessages } from "../compact/compactor.ts";
import { defaultContextBudgetEstimator } from "../session/context-budget.ts";

export const DEFAULT_MAX_STEPS = 20;

export type RunStatus = "running" | "succeeded" | "cancelled" | "failed";

/** run.finished 失败分支的 reason 枚举，与协议层 RunFinishedPayloadSchema 一致。 */
export type FailedReason =
  | "config_error"
  | "llm_error"
  | "max_steps"
  | "run_timeout"
  | "invalid_llm_response"
  | "event_store_error"
  | "internal_error";

/** 全部 reason：成功/取消用固定值，失败用 FailedReason。 */
export type RunFinishReason = "completed" | "cancelled" | FailedReason;

export interface ToolResultBlock {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface ExecutionContextOptions {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly userContent?: readonly LlmContentPart[];
  /** 已成功历史构成的 provider-neutral 消息；本轮用户消息会追加在其后。 */
  readonly prefillMessages?: readonly LlmMessage[];
  readonly prefillEntries?: readonly ContextEntry[];
  readonly maxSteps?: number;
}

/**
 * 一次 run 的隔离可变状态。所有字段仅属于当前 session/run，
 * 不同 context 实例之间不存在任何共享引用。
 */
export class ExecutionContext {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly maxSteps: number;
  readonly messages: LlmMessage[] = [];
  readonly #audit: ContextEntry[] = [];
  #entries: ContextEntry[] = [];
  #usageAnchor: { tokens: number; count: number } | undefined;
  failureCode: string | undefined;
  step = 0;
  status: RunStatus = "running";
  reason: FailedReason | undefined;
  finalText = "";
  /** 该 run 实际使用的模型标识，由 AgentLoop 在选中模型时写入。 */
  model = "";
  usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  constructor(options: ExecutionContextOptions) {
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.workspaceRoot = options.workspaceRoot;
    this.goal = options.goal;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#entries = (
      options.prefillEntries ??
      options.prefillMessages?.map((message) => ({
        ...message,
        messageId: crypto.randomUUID(),
      })) ??
      []
    ).map((entry) => ({ ...entry, content: entry.content.map((part) => ({ ...part })) }));
    this.messages.push(...toProviderMessages(this.#entries));
    this.#append({
      role: "user",
      content: options.userContent
        ? structuredClone([...options.userContent])
        : [{ type: "text", text: this.goal }],
    });
  }

  /** 当前状态是否已经进入终态。 */
  isDone(): boolean {
    return this.status !== "running";
  }

  /** 追加本轮 Assistant 消息；空内容不进入上下文。 */
  addAssistantMessage(content: readonly LlmContentPart[]): void {
    if (content.length === 0) {
      return;
    }
    this.#append({ role: "assistant", content: [...content] });
  }

  /** 用普通用户上下文交付后台子结果，保持 tool_use/tool_result 配对不变。 */
  addUserContext(text: string): void {
    this.#append({ role: "user", content: [{ type: "text", text }] });
  }

  /** 同一轮的全部工具结果合并为一条 user message。 */
  addToolResults(results: readonly ToolResultBlock[]): void {
    if (results.length === 0) {
      return;
    }
    this.#append({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result" as const,
        toolUseId: result.toolUseId,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      })),
    });
  }

  /** 累加一次 provider 调用的 token 用量。 */
  accumulateUsage(usage: LlmUsage): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + usage.inputTokens,
      outputTokens: this.usage.outputTokens + usage.outputTokens,
      cacheReadInputTokens: this.usage.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        this.usage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    };
  }

  /** 将 run 标记为成功并保存最终文本。 */
  markSucceeded(finalText: string): void {
    this.status = "succeeded";
    this.reason = undefined;
    this.finalText = finalText;
  }

  /** 将 run 标记为指定原因的失败。 */
  markFailed(reason: FailedReason): void {
    this.status = "failed";
    this.reason = reason;
  }

  /** 将 run 标记为用户取消。 */
  markCancelled(): void {
    this.status = "cancelled";
    this.reason = undefined;
  }

  /** 返回仅属于本轮的新消息，供审计历史提交使用。 */
  runMessages(): readonly LlmMessage[] {
    return toProviderMessages(this.#audit);
  }
  /** 新消息同时进入完整审计与当前模型视图，身份在压缩与落盘间保持稳定。 */
  #append(message: LlmMessage): void {
    const entry = { ...message, messageId: crypto.randomUUID(), runId: this.runId };
    this.#audit.push(entry);
    this.#entries.push(entry);
    this.messages.push(message);
  }

  /** 获取带身份的当前上下文，供压缩服务选择切点。 */
  get contextEntries(): readonly ContextEntry[] {
    return this.#entries;
  }

  /** 仅替换模型视图；已生成的本轮审计消息永远保留。 */
  replaceContext(entries: readonly ContextEntry[]): void {
    this.#entries = [...entries];
    this.messages.splice(0, this.messages.length, ...toProviderMessages(entries));
    this.#usageAnchor = undefined;
  }

  /** 返回审计消息的运行期身份，供终态提交复用。 */
  runMessageIds(): readonly string[] {
    return this.#audit.map((entry) => entry.messageId);
  }

  /** 最近一次真实 usage 包含输入、缓存和输出；无有效 usage 时回到整体估算。 */
  anchorUsage(usage: LlmUsage): void {
    const tokens =
      usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens +
      usage.outputTokens;
    this.#usageAnchor =
      Number.isSafeInteger(tokens) && tokens > 0
        ? { tokens, count: this.messages.length }
        : undefined;
  }

  /** 当前占用使用单次调用 usage 加后续新增消息；不使用累计账单用量。 */
  contextTokens(system: string, tools: unknown): number {
    if (this.#usageAnchor !== undefined) {
      const trailing = this.messages.slice(this.#usageAnchor.count);
      return (
        this.#usageAnchor.tokens + (trailing.length ? defaultContextBudgetEstimator(trailing) : 0)
      );
    }
    return (
      defaultContextBudgetEstimator(system) +
      defaultContextBudgetEstimator(tools) +
      defaultContextBudgetEstimator(this.messages)
    );
  }
}
