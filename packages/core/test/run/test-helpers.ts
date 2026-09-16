import type { Environment } from "@minicode/protocol";
import { LlmError } from "../../src/llm/errors.ts";
import type { LlmProvider, LlmStreamOptions } from "../../src/llm/provider.ts";
import type { LlmMessage, LlmStreamEvent } from "../../src/llm/types.ts";

/** 含合法 LLM 配置的环境，用于走真实 provider 工厂分支。 */
export function environmentWithLlm(overrides: Partial<Environment> = {}): Environment {
  return {
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: "http://127.0.0.1:1",
    LLM_MODEL: "test-model",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    ...overrides,
  };
}

/** 不含任何 LLM 配置的环境，用于触发 config_error。 */
export function environmentWithoutLlm(): Environment {
  return {
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
  };
}

/**
 * 挂起直到 abort 的 provider，用于验证整 run 超时与取消都能中断循环。
 * 响应 signal 抛 aborted，由 AgentLoop 将外部取消收敛为 cancelled。
 */
export class HangProvider implements LlmProvider {
  readonly providerName = "hang";
  readonly model = "hang-model";

  async *stream(
    _messages: readonly LlmMessage[],
    options?: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        reject(new LlmError("aborted", "aborted before stream"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new LlmError("aborted", "aborted during stream")),
        { once: true },
      );
    });
    // 不可达：上面的 Promise 永不 resolve，只在 abort 时 reject。
    yield {
      type: "completed",
      response: {
        text: "",
        toolCalls: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        finishReason: "end_turn",
      },
    };
  }
}
