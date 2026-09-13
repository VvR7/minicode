import { describe, expect, test } from "bun:test";

import { AnthropicAdapter } from "../../src/llm/anthropic-adapter.ts";
import type { FetchLike } from "../../src/llm/anthropic-adapter.ts";
import { LlmError } from "../../src/llm/errors.ts";
import type { LlmConfig } from "../../src/llm/config.ts";
import type { LlmMessage, LlmStreamEvent } from "../../src/llm/types.ts";
import {
  anthropicSseEvents,
  collect,
  collectWithError,
  hangingStreamFetch,
  jsonResponse,
  sequenceFetch,
  sseResponse,
} from "./test-helpers.ts";

const config: LlmConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.anthropic.com",
  model: "test-model",
};

const userMessage: LlmMessage = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

interface Capture {
  url?: string;
  init?: RequestInit;
}

interface AnthropicRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: boolean;
  readonly messages: unknown[];
  readonly system?: string;
  readonly tools?: unknown[];
}

function captureFetch(capture: Capture, response: Response): FetchLike {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return response;
  };
}

function requestBody(init: RequestInit | undefined): AnthropicRequestBody {
  return JSON.parse(String(init?.body)) as AnthropicRequestBody;
}

describe("request construction", () => {
  test("builds the Anthropic endpoint, headers and body", async () => {
    const capture: Capture = {};
    const adapter = new AnthropicAdapter(
      config,
      captureFetch(
        capture,
        sseResponse(anthropicSseEvents({ text: "hi", inputTokens: 1, outputTokens: 1 })),
      ),
      [0, 0],
    );

    await collect(
      adapter.stream([userMessage], {
        system: "be helpful",
        toolSchemas: [
          { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
        ],
      }),
    );

    expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
    expect(capture.init?.method).toBe("POST");
    expect(capture.init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });

    const body = requestBody(capture.init);
    expect(body).toMatchObject({
      model: "test-model",
      max_tokens: 8192,
      stream: true,
      system: "be helpful",
      tools: [{ name: "read_file", description: "read a file", input_schema: { type: "object" } }],
    });
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("tolerates a trailing slash and non-root base URL path", async () => {
    const capture: Capture = {};
    const adapter = new AnthropicAdapter(
      { ...config, baseUrl: "https://api.deepseek.com/anthropic/" },
      captureFetch(capture, sseResponse(anthropicSseEvents({ inputTokens: 1, outputTokens: 1 }))),
      [0, 0],
    );
    await collect(adapter.stream([userMessage]));
    expect(capture.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  test("converts tool_use and tool_result history to snake_case", async () => {
    const capture: Capture = {};
    const adapter = new AnthropicAdapter(
      config,
      captureFetch(capture, sseResponse(anthropicSseEvents({ inputTokens: 1, outputTokens: 1 }))),
      [0, 0],
    );
    const history: LlmMessage[] = [
      userMessage,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "file body", isError: false }],
      },
    ];
    await collect(adapter.stream(history));

    const body = requestBody(capture.init);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file body", is_error: false },
        ],
      },
    ]);
  });
});

describe("streaming accumulation", () => {
  test("emits text deltas and a completed event for plain text", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () =>
        sseResponse(anthropicSseEvents({ text: "hello world", inputTokens: 5, outputTokens: 11 })),
      [0, 0],
    );

    const events = await collect(adapter.stream([userMessage]));

    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    expect(deltas.join("")).toBe("hello world");
    expect(events.at(-1)).toEqual({
      type: "completed",
      response: {
        text: "hello world",
        toolCalls: [],
        usage: {
          inputTokens: 5,
          outputTokens: 11,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        finishReason: "end_turn",
      },
    });
  });

  test("accumulates multiple tool calls with parsed JSON inputs", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () =>
        sseResponse(
          anthropicSseEvents({
            finishReason: "tool_use",
            inputTokens: 3,
            outputTokens: 4,
            toolCalls: [
              { id: "t1", name: "read_file", input: { path: "a.txt" } },
              { id: "t2", name: "grep", input: { pattern: "x" } },
            ],
          }),
        ),
      [0, 0],
    );

    const events = await collect(adapter.stream([userMessage]));
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      response: {
        finishReason: "tool_use",
        toolCalls: [
          { id: "t1", name: "read_file", input: { path: "a.txt" } },
          { id: "t2", name: "grep", input: { pattern: "x" } },
        ],
      },
    });
  });

  test("extracts cache usage when present", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () =>
        sseResponse(
          anthropicSseEvents({
            text: "ok",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 3,
          }),
        ),
      [0, 0],
    );
    const events = await collect(adapter.stream([userMessage]));
    const completed = events.find((e) => e.type === "completed");
    if (completed?.type === "completed") {
      expect(completed.response.usage).toEqual({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
      });
    } else {
      throw new Error("expected completed event");
    }
  });
});

describe("retry", () => {
  test("retries a 429 and succeeds", async () => {
    const fetch = sequenceFetch(
      async () => jsonResponse({ error: { type: "rate_limit_error" } }, 429),
      async () =>
        sseResponse(anthropicSseEvents({ text: "recovered", inputTokens: 1, outputTokens: 1 })),
    );
    const adapter = new AnthropicAdapter(config, fetch, [0, 0]);

    const events = await collect(adapter.stream([userMessage]));

    expect(events[0]).toEqual({
      type: "retrying",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 0,
      reason: "rate_limit",
    });
    expect(events.at(-1)?.type).toBe("completed");
  });

  test("retries a network error and succeeds", async () => {
    const fetch = sequenceFetch(
      async () => {
        throw new Error("connection refused");
      },
      async () => sseResponse(anthropicSseEvents({ text: "ok", inputTokens: 1, outputTokens: 1 })),
    );
    const adapter = new AnthropicAdapter(config, fetch, [0, 0]);

    const events = await collect(adapter.stream([userMessage]));
    expect(events[0]).toMatchObject({ type: "retrying", reason: "network", attempt: 2 });
    expect(events.at(-1)?.type).toBe("completed");
  });

  test("gives up after max attempts and surfaces the last error", async () => {
    const fetch = sequenceFetch(
      async () => jsonResponse({}, 503),
      async () => jsonResponse({}, 503),
      async () => jsonResponse({}, 503),
    );
    const adapter = new AnthropicAdapter(config, fetch, [0, 0]);

    const { events, error } = await collectWithError(adapter.stream([userMessage]));

    expect(events).toEqual([
      { type: "retrying", attempt: 2, maxAttempts: 3, delayMs: 0, reason: "unavailable" },
      { type: "retrying", attempt: 3, maxAttempts: 3, delayMs: 0, reason: "unavailable" },
    ]);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("unavailable");
  });

  test("does not retry after the first delta", async () => {
    const encoder = new TextEncoder();
    const fetch: FetchLike = async () => {
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              encoder.encode(
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
              ),
            );
          } else {
            controller.error(new Error("stream dropped"));
          }
        },
      });
      return new Response(stream, { status: 200 });
    };
    const adapter = new AnthropicAdapter(config, fetch, [0, 0]);

    const { events, error } = await collectWithError(adapter.stream([userMessage]));

    // 首 delta 已对外发布，之后网络中断不得重试，也不得再产生 retrying 事件。
    expect(events).toEqual([{ type: "text_delta", text: "partial" }]);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("network_error");
  });
});

describe("timeout and abort", () => {
  test("fails with timeout when the stream hangs", async () => {
    const adapter = new AnthropicAdapter(config, hangingStreamFetch(), [0, 0]);
    await expect(collect(adapter.stream([userMessage], { timeoutMs: 20 }))).rejects.toThrow(
      "LLM call timed out",
    );
  });

  test("fails with aborted when the caller cancels", async () => {
    const adapter = new AnthropicAdapter(config, hangingStreamFetch(), [0, 0]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(adapter.stream([userMessage], { signal: controller.signal })),
    ).rejects.toThrow("LLM call aborted");
  });

  test("maps timeout during retry backoff to a typed timeout error", async () => {
    const adapter = new AnthropicAdapter(config, async () => jsonResponse({}, 503), [100]);
    const { error } = await collectWithError(adapter.stream([userMessage], { timeoutMs: 10 }));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("timeout");
  });
});

describe("malformed responses", () => {
  test("rejects invalid JSON data", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () => new Response("data: not-json\n\n", { status: 200 }),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow(
      "SSE data is not valid JSON",
    );
  });

  test("rejects an unknown SSE event shape", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () => new Response('data: {"type":"unknown_event"}\n\n', { status: 200 }),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow("unknown SSE event shape");
  });

  test("rejects a stream that never emits message_start", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () =>
        sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow(
      "stream ended without message_start",
    );
  });

  test("rejects a stream without stop_reason", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () =>
        sseResponse([
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow(
      "stream ended without stop_reason",
    );
  });

  test("rejects an unsupported stop_reason", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () => sseResponse(anthropicSseEvents({ text: "x", finishReason: "refusal" })),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow("unsupported stop_reason");
  });

  test("rejects a non-2xx response without retrying", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () => jsonResponse({ error: { message: "bad key" } }, 401),
      [0, 0],
    );
    const { error } = await collectWithError(adapter.stream([userMessage]));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("invalid_response");
  });

  test("rejects an empty body", async () => {
    const adapter = new AnthropicAdapter(
      config,
      async () => new Response(null, { status: 200 }),
      [0, 0],
    );
    await expect(collect(adapter.stream([userMessage]))).rejects.toThrow("empty body");
  });
});

describe("concurrency", () => {
  test("concurrent streams do not share mutable state", async () => {
    const encoder = new TextEncoder();
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: LlmMessage[] };
      const firstText = body.messages[0]?.content[0];
      const text = firstText?.type === "text" ? firstText.text : "";
      const reply = `reply:${text}`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const adapter = new AnthropicAdapter(config, fetch, [0, 0]);

    const [a, b] = await Promise.all([
      collect(adapter.stream([{ role: "user", content: [{ type: "text", text: "aaa" }] }])),
      collect(adapter.stream([{ role: "user", content: [{ type: "text", text: "bbb" }] }])),
    ]);

    const textOf = (events: LlmStreamEvent[]): string => {
      for (const event of events) {
        if (event.type === "completed") {
          return event.response.text;
        }
      }
      return "";
    };
    expect(textOf(a)).toBe("reply:aaa");
    expect(textOf(b)).toBe("reply:bbb");
  });
});
