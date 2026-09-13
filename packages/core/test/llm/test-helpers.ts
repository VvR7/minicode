import type { FetchLike } from "../../src/llm/anthropic-adapter.ts";
import type { LlmStreamEvent } from "../../src/llm/types.ts";

/** 收集一个异步迭代器的全部元素，方便断言流事件序列。 */
export async function collect(iterable: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** 收集事件直到成功或失败，返回已收集的事件与最终错误（若有）。 */
export async function collectWithError(
  iterable: AsyncIterable<LlmStreamEvent>,
): Promise<{ events: LlmStreamEvent[]; error: unknown }> {
  const events: LlmStreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of iterable) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

/** 构造一个 JSON 响应。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造一个标准 Anthropic SSE 响应（含 event 名与 data 行）。 */
export function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => {
      const type =
        typeof event === "object" && event !== null && "type" in event
          ? String(event.type)
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** 按顺序返回多个 handler 的结果，超出后重复最后一个。 */
export function sequenceFetch(...handlers: FetchLike[]): FetchLike {
  let index = 0;
  return async (url, init) => {
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    if (handler === undefined) {
      throw new Error("sequenceFetch exhausted");
    }
    return handler(url, init);
  };
}

/** 返回一个永不主动结束、但在调用方 signal abort 时中断的流，用于触发 timeout 或 abort。 */
export function hangingStreamFetch(): FetchLike {
  return async (_url, init) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = (): void => controller.error(new DOMException("aborted", "AbortError"));
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  };
}

export interface AnthropicSseFixtureOptions {
  readonly text?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

/** 按 3 字符切分文本，模拟真实的增量 delta。 */
function splitText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 3) {
    chunks.push(text.slice(i, i + 3));
  }
  return chunks.length > 0 ? chunks : [""];
}

/**
 * 生成一段结构真实的 Anthropic SSE 事件序列。
 * 顺序：message_start → 文本块 → 工具块 → message_delta → message_stop。
 */
export function anthropicSseEvents(options: AnthropicSseFixtureOptions): unknown[] {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: options.inputTokens ?? 0,
          cache_read_input_tokens: options.cacheReadInputTokens ?? null,
          cache_creation_input_tokens: options.cacheCreationInputTokens ?? null,
        },
      },
    },
  ];

  let index = 0;
  if (options.text !== undefined && options.text.length > 0) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    for (const chunk of splitText(options.text)) {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: chunk },
      });
    }
    events.push({ type: "content_block_stop", index });
    index += 1;
  }

  for (const call of options.toolCalls ?? []) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    });
    events.push({ type: "content_block_stop", index });
    index += 1;
  }

  events.push({
    type: "message_delta",
    delta: { stop_reason: options.finishReason ?? "end_turn" },
    usage: { output_tokens: options.outputTokens ?? 0 },
  });
  events.push({ type: "message_stop" });
  return events;
}
