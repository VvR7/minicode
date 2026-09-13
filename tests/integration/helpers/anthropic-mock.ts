import type { Server } from "bun";

/** 一个本地 Anthropic Messages API mock：驱动真实 core 进程走完工具调用闭环。 */
export interface MockAnthropicServer {
  /** LLM_BASE_URL 指向的 base url（不含 /v1/messages）。 */
  readonly url: string;
  readonly port: number;
  readonly callCount: number;
  stop(): Promise<void>;
}

export interface MockAnthropicOptions {
  /** 依据 read_file 等工具返回的 observation 内容生成最终回答文本。 */
  readonly finalText?: (toolResults: readonly string[]) => string;
  /** 每次请求前的延迟毫秒数，用于制造慢速 run。 */
  readonly delayMs?: number;
  /** 在返回 tool_use 前挂起，配合 release() 控制时序。 */
  readonly gate?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从请求体中抽取全部 tool_result 的文本内容。 */
function extractToolResults(body: unknown): string[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const results: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const typed = part as { type?: unknown; content?: unknown };
      if (typed.type === "tool_result" && typeof typed.content === "string") {
        results.push(typed.content);
      }
    }
  }
  return results;
}

/** 组装一条 Anthropic SSE 事件流响应。 */
function sseResponse(events: readonly unknown[]): Response {
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

/** 首次调用返回的 read_file(README.md) tool_use 事件序列。 */
function toolUseEvents(): unknown[] {
  const input = { path: "README.md" };
  return [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ];
}

/** 最终回答的 end_turn 事件序列，按 4 字符切分文本模拟增量。 */
function finalTextEvents(text: string): unknown[] {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ];
  for (let i = 0; i < text.length; i += 4) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(i, i + 4) },
    });
  }
  events.push({ type: "content_block_stop", index: 0 });
  events.push({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 30 },
  });
  events.push({ type: "message_stop" });
  return events;
}

/**
 * 启动 mock Anthropic Messages 服务。首个请求（无 tool_result）返回 read_file 调用，
 * 后续请求（含 tool_result）返回 finalText(toolResults) 作为最终回答。
 */
export function startAnthropicMock(options: MockAnthropicOptions = {}): MockAnthropicServer {
  let callCount = 0;
  const finalText = options.finalText ?? ((results) => `SUMMARY:${results.join("|")}`);
  const gate = options.gate === true;
  let server: Server<undefined>;

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      const body = await request.json();
      callCount += 1;
      const toolResults = extractToolResults(body);
      if (options.delayMs !== undefined) {
        await sleep(options.delayMs);
      }
      if (gate && toolResults.length === 0) {
        return sseResponse(toolUseEvents());
      }
      if (toolResults.length === 0) {
        return sseResponse(toolUseEvents());
      }
      return sseResponse(finalTextEvents(finalText(toolResults)));
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("mock server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get callCount() {
      return callCount;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
