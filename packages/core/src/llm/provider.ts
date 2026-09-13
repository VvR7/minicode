import type { LlmMessage, LlmStreamEvent, LlmToolSchema } from "./types.ts";

/** 一次流式调用可覆盖的选项。 */
export interface LlmStreamOptions {
  /** 系统提示词；缺省时由 Agent 层决定，provider 不内置默认 prompt。 */
  readonly system?: string;
  /** 供模型调用的工具 JSON Schema 列表。 */
  readonly toolSchemas?: readonly LlmToolSchema[];
  /** 调用方取消信号；触发时 stream 抛 aborted，不进入重试。 */
  readonly signal?: AbortSignal;
  /** 整次调用（含重试）的统一超时毫秒数。 */
  readonly timeoutMs?: number;
  /** 首 delta 前的最大尝试次数，默认 3。 */
  readonly maxAttempts?: number;
}

/**
 * provider 中立接口：只消费归一化消息、输出标准化流事件。
 * 实现不得依赖 EventBus、sessionId、runId，也不得保留跨调用的可变状态。
 */
export interface LlmProvider {
  readonly providerName: string;
  readonly model: string;
  stream(
    messages: readonly LlmMessage[],
    options?: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent>;
}
