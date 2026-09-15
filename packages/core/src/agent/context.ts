import type { RunId, SessionId } from "@minicode/protocol";
import type { LlmContentPart, LlmMessage, LlmUsage } from "../llm/types.ts";

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
  /** 已成功历史构成的 provider-neutral 消息；本轮用户消息会追加在其后。 */
  readonly prefillMessages?: readonly LlmMessage[];
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
  readonly #runMessageStart: number;
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
    for (const message of options.prefillMessages ?? []) {
      this.messages.push({
        role: message.role,
        content: message.content.map((part) => ({ ...part })),
      });
    }
    this.#runMessageStart = this.messages.length;
    // goal 是本轮第一条消息，历史消息不会重复写入本轮 completion。
    this.messages.push({ role: "user", content: [{ type: "text", text: this.goal }] });
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
    this.messages.push({ role: "assistant", content: [...content] });
  }

  /** 同一轮的全部工具结果合并为一条 user message。 */
  addToolResults(results: readonly ToolResultBlock[]): void {
    if (results.length === 0) {
      return;
    }
    this.messages.push({
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
    return this.messages.slice(this.#runMessageStart);
  }
}
