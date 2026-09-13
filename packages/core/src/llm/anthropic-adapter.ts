import { z } from "zod";
import type { LlmConfig } from "./config.ts";
import { LlmError, type LlmErrorCode } from "./errors.ts";
import type { LlmProvider, LlmStreamOptions } from "./provider.ts";
import { parseSseStream } from "./sse.ts";
import type {
  LlmFinishReason,
  LlmMessage,
  LlmResponse,
  LlmRetryReason,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.ts";
import { LlmFinishReasonSchema } from "./types.ts";

/** Anthropic Messages API 版本头。 */
export const ANTHROPIC_VERSION = "2023-06-01" as const;
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000] as const;

/** 可注入的 HTTP 传输，生产用 fetch，测试注入 mock。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 拼接 baseUrl 与相对路径，容忍 baseUrl 末尾有无斜杠。 */
function endpoint(baseUrl: string, pathname: string): string {
  return new URL(pathname.replace(/^\//, ""), `${baseUrl.replace(/\/?$/, "/")}`).toString();
}

/** 把 HTTP 状态映射为类型化错误，仅 429 与 5xx 可重试。 */
function httpError(status: number): LlmError {
  if (status === 429) {
    return new LlmError("rate_limit", `LLM request rate limited (HTTP 429)`);
  }
  if (status >= 500 && status <= 599) {
    return new LlmError("unavailable", `LLM service unavailable (HTTP ${status})`);
  }
  return new LlmError("invalid_response", `LLM request rejected (HTTP ${status})`);
}

/** 把任意失败归一化为 LlmError；非 LlmError 一律视为网络错误。 */
function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  return new LlmError("network_error", "LLM network request failed");
}

/** 把可重试错误码转换为流事件的 reason（仅可重试码会走到这里）。 */
function retryReason(code: LlmErrorCode): LlmRetryReason {
  switch (code) {
    case "network_error":
      return "network";
    case "rate_limit":
      return "rate_limit";
    case "unavailable":
      return "unavailable";
    default:
      // 不可重试码不会触发重试，防御性返回 network。
      return "network";
  }
}

/** 归一化 Anthropic 停止原因；未知值视为非法响应。 */
function mapFinishReason(stopReason: string): LlmFinishReason {
  const parsed = LlmFinishReasonSchema.safeParse(stopReason);
  if (!parsed.success) {
    throw new LlmError("invalid_response", `unsupported stop_reason: ${stopReason}`);
  }
  return parsed.data;
}

/** 把 provider 中立消息转换为 Anthropic Messages 请求体。 */
function toAnthropicMessages(messages: readonly LlmMessage[]): Record<string, unknown>[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "tool_use":
          return { type: "tool_use", id: part.id, name: part.name, input: part.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: part.toolUseId,
            content: part.content,
            ...(part.isError === undefined ? {} : { is_error: part.isError }),
          };
        default:
          return assertNever(part);
      }
    }),
  }));
}

/** 穷尽检查：switch 覆盖所有变体后用于拦截非法输入。 */
function assertNever(value: never): never {
  throw new LlmError("invalid_response", `unexpected content part: ${String(value)}`);
}

// ===== Anthropic SSE 事件 schema =====
// 只校验累积结果所需的字段，嵌套对象 passthrough 以容忍 thinking 等扩展字段。

const SseInputUsageSchema = z
  .strictObject({
    input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const AnthropicSseEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("message_start"),
    message: z.strictObject({ usage: SseInputUsageSchema }).passthrough(),
  }),
  z.strictObject({
    type: z.literal("content_block_start"),
    index: z.number().int().nonnegative(),
    content_block: z
      .strictObject({
        type: z.string().min(1),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  }),
  z.strictObject({
    type: z.literal("content_block_delta"),
    index: z.number().int().nonnegative(),
    delta: z
      .strictObject({
        type: z.string().min(1),
        text: z.string().optional(),
        partial_json: z.string().optional(),
      })
      .passthrough(),
  }),
  z.strictObject({
    type: z.literal("content_block_stop"),
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("message_delta"),
    delta: z.strictObject({ stop_reason: z.string().nullable().optional() }).passthrough(),
    usage: z
      .strictObject({ output_tokens: z.number().int().nonnegative() })
      .passthrough()
      .optional(),
  }),
  z.strictObject({ type: z.literal("message_stop") }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({
      type: z.string().optional(),
      message: z.string().optional(),
    }),
  }),
  z.strictObject({ type: z.literal("ping") }),
]);

type AnthropicSseEvent = z.infer<typeof AnthropicSseEventSchema>;

/** 一次流式调用内的累积状态；全部为局部变量，天然无跨调用串扰。 */
interface SseAccumulator {
  readonly textParts: string[];
  readonly toolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  stopReason: string | undefined;
  sawMessageStart: boolean;
}

function createAccumulator(): SseAccumulator {
  return {
    textParts: [],
    toolCalls: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    stopReason: undefined,
    sawMessageStart: false,
  };
}

/** 消费一条 SSE 事件并更新累积器；返回需要对外发布的文本增量。 */
function handleSseEvent(event: AnthropicSseEvent, acc: SseAccumulator): string | undefined {
  switch (event.type) {
    case "message_start": {
      acc.inputTokens = event.message.usage.input_tokens;
      acc.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
      acc.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0;
      acc.sawMessageStart = true;
      return undefined;
    }
    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "tool_use" && block.id !== undefined && block.name !== undefined) {
        acc.toolCalls.set(event.index, { id: block.id, name: block.name, inputJson: "" });
      }
      return undefined;
    }
    case "content_block_delta": {
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        acc.textParts.push(delta.text);
        return delta.text;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const call = acc.toolCalls.get(event.index);
        if (call !== undefined) {
          call.inputJson += delta.partial_json;
        }
      }
      return undefined;
    }
    case "message_delta": {
      if (typeof event.delta.stop_reason === "string") {
        acc.stopReason = event.delta.stop_reason;
      }
      if (event.usage !== undefined) {
        acc.outputTokens = event.usage.output_tokens;
      }
      return undefined;
    }
    case "error": {
      const code = mapProviderErrorType(event.error.type);
      throw new LlmError(code, event.error.message ?? "provider returned an error");
    }
    case "content_block_stop":
    case "message_stop":
    case "ping":
      return undefined;
  }
}

/** 把 provider error.type 映射为可重试或不可重试的领域错误码。 */
function mapProviderErrorType(type: string | undefined): LlmErrorCode {
  switch (type) {
    case "rate_limit_error":
      return "rate_limit";
    case "overloaded_error":
    case "api_error":
      return "unavailable";
    default:
      return "invalid_response";
  }
}

/** 校验并组装累积结果为归一化响应。 */
function finalize(acc: SseAccumulator): LlmResponse {
  if (!acc.sawMessageStart) {
    throw new LlmError("invalid_response", "stream ended without message_start");
  }
  if (acc.stopReason === undefined) {
    throw new LlmError("invalid_response", "stream ended without stop_reason");
  }
  const finishReason = mapFinishReason(acc.stopReason);

  const toolCalls: LlmToolCall[] = [];
  const ordered = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, call] of ordered) {
    let input: unknown;
    try {
      input = JSON.parse(call.inputJson.length === 0 ? "{}" : call.inputJson);
    } catch {
      throw new LlmError("invalid_response", "tool call input JSON is invalid");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new LlmError("invalid_response", "tool call input is not an object");
    }
    toolCalls.push({ id: call.id, name: call.name, input: input as Record<string, unknown> });
  }

  return {
    text: acc.textParts.join(""),
    toolCalls,
    usage: {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens,
    },
    finishReason,
  };
}

/** 可被 abort 中断的延迟；abort 时以 AbortError 拒绝，由调用方映射为 aborted。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Anthropic Messages 兼容 adapter。通过可注入 fetch 实现流式调用，
 * 统一处理 timeout、abort 与首 delta 前的有限重试。
 */
export class AnthropicAdapter implements LlmProvider {
  readonly providerName = "anthropic" as const;
  readonly model: string;
  readonly #config: LlmConfig;
  readonly #fetchImpl: FetchLike;
  readonly #backoffDelaysMs: readonly number[];

  constructor(
    config: LlmConfig,
    fetchImpl: FetchLike = fetch,
    backoffDelaysMs: readonly number[] = RETRY_BACKOFF_MS,
  ) {
    this.#config = config;
    this.#fetchImpl = fetchImpl;
    this.model = config.model;
    this.#backoffDelaysMs = backoffDelaysMs;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions = {},
  ): AsyncIterable<LlmStreamEvent> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const externalSignal = options.signal;

    // 统一超时信号：外部取消与内部超时都通过同一个 controller 中断 fetch/读取。
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let sawDelta = false;
        try {
          const response = await this.#request(messages, options, controller.signal);
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          if (response.body === null) {
            throw new LlmError("invalid_response", "LLM returned an empty body");
          }

          const acc = createAccumulator();
          for await (const sse of parseSseStream(response.body)) {
            let raw: unknown;
            try {
              raw = JSON.parse(sse.data);
            } catch {
              throw new LlmError("invalid_response", "SSE data is not valid JSON");
            }
            const parsed = AnthropicSseEventSchema.safeParse(raw);
            if (!parsed.success) {
              throw new LlmError("invalid_response", "unknown SSE event shape");
            }
            const textDelta = handleSseEvent(parsed.data, acc);
            if (textDelta !== undefined && textDelta.length > 0) {
              sawDelta = true;
              yield { type: "text_delta", text: textDelta };
            }
          }

          yield { type: "completed", response: finalize(acc) };
          return;
        } catch (error) {
          // 取消与超时优先于任何重试决策，且都必须可区分。
          if (externalSignal?.aborted === true) {
            throw new LlmError("aborted", "LLM call aborted");
          }
          if (timedOut) {
            throw new LlmError("timeout", "LLM call timed out");
          }

          const llmError = toLlmError(error);
          // 首 delta 后不再重试，避免对外重复输出内容。
          if (!llmError.retryable || sawDelta || attempt >= maxAttempts) {
            throw llmError;
          }

          const backoffIndex = Math.min(attempt - 1, this.#backoffDelaysMs.length - 1);
          const delayMs = this.#backoffDelaysMs[backoffIndex] ?? 1000;
          yield {
            type: "retrying",
            attempt: attempt + 1,
            maxAttempts,
            delayMs,
            reason: retryReason(llmError.code),
          };
          try {
            await sleep(delayMs, controller.signal);
          } catch {
            // sleep 的 AbortError 也必须遵循与 fetch/reader 相同的错误契约。
            if (timedOut) {
              throw new LlmError("timeout", "LLM call timed out");
            }
            throw new LlmError("aborted", "LLM call aborted");
          }
        }
      }
    } finally {
      // 无论正常完成、解析失败还是消费者提前退出，都中断底层请求/响应体，避免残留流。
      controller.abort();
      clearTimeout(timeoutTimer);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  async #request(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
    signal: AbortSignal,
  ): Promise<Response> {
    const body: {
      model: string;
      max_tokens: number;
      stream: boolean;
      messages: Record<string, unknown>[];
      system?: string;
      tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
    } = {
      model: this.#config.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (options.system !== undefined) {
      body.system = options.system;
    }
    if (options.toolSchemas !== undefined && options.toolSchemas.length > 0) {
      body.tools = options.toolSchemas.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    try {
      return await this.#fetchImpl(endpoint(this.#config.baseUrl, "v1/messages"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      // fetch 抛出的原始错误可能携带请求上下文，不向上传播；统一为网络错误。
      throw new LlmError("network_error", "LLM network request failed");
    }
  }
}
