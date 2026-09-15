import type { Server } from "bun";

/** 测试 barrier：先通过 reached 通知测试，再等待 release，避免依赖墙钟延迟。 */
export interface TestBarrier {
  readonly reached: Promise<void>;
  /** provider 到达切点时调用；测试代码通常只等待 reached 并调用 release。 */
  wait(): Promise<void>;
  /** 释放已经到达的 provider 流。 */
  release(): void;
}

/** 创建一次性的确定性测试 barrier。 */
export function createBarrier(): TestBarrier {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    /** 标记 provider 已到达切点，并等待测试释放。 */
    async wait() {
      reached.resolve();
      await released.promise;
    },
  };
}

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ScriptedReply =
  | { readonly kind: "tools"; readonly calls: readonly ScriptedToolCall[] }
  | {
      readonly kind: "text";
      readonly chunks: readonly string[];
      /** 在发送完 afterChunks 个 delta 后暂停响应。 */
      readonly barrier?: TestBarrier;
      readonly afterChunks?: number;
    }
  | { readonly kind: "error"; readonly status?: number };

export interface ScriptedAnthropicServer {
  readonly url: string;
  readonly requestBodies: readonly unknown[];
  readonly callCount: number;
  stop(): Promise<void>;
}

/** 把一个 Anthropic SSE 事件编码为 wire bytes。 */
function encodeEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    `event: ${String(Reflect.get(event, "type"))}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/** 每次 provider 调用的稳定 usage 头。 */
function messageStart(): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    },
  };
}

/** 构造包含一个或多个工具调用的完整 SSE 响应。 */
function toolResponse(calls: readonly ScriptedToolCall[]): Response {
  const events: Record<string, unknown>[] = [messageStart()];
  calls.forEach((call, index) => {
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
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 10 },
  });
  events.push({ type: "message_stop" });
  return new Response(
    events.map(encodeEvent).reduce((all, item) => `${all}${new TextDecoder().decode(item)}`, ""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

/** 构造可在任意 delta 后由测试释放的流式文本响应。 */
function textResponse(reply: Extract<ScriptedReply, { kind: "text" }>): Response {
  const barrier = reply.barrier;
  const afterChunks = reply.afterChunks ?? reply.chunks.length;
  const body = new ReadableStream<Uint8Array>({
    /** 顺序推送 delta，并在指定切点等待 barrier。 */
    async start(controller) {
      controller.enqueue(encodeEvent(messageStart()));
      controller.enqueue(
        encodeEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      for (const [index, chunk] of reply.chunks.entries()) {
        controller.enqueue(
          encodeEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunk },
          }),
        );
        if (barrier !== undefined && index + 1 === afterChunks) await barrier.wait();
      }
      controller.enqueue(encodeEvent({ type: "content_block_stop", index: 0 }));
      controller.enqueue(
        encodeEvent({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 10 },
        }),
      );
      controller.enqueue(encodeEvent({ type: "message_stop" }));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * 启动按请求序号返回脚本响应的本地 Anthropic mock。
 * handler 可以检查完整请求体，并用 barrier 精确控制 SSE 时序。
 */
export function startScriptedAnthropicMock(
  handler: (body: unknown, call: number) => ScriptedReply | Promise<ScriptedReply>,
): ScriptedAnthropicServer {
  const requestBodies: unknown[] = [];
  let callCount = 0;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /** 只处理 Anthropic Messages API，其他请求明确返回 404。 */
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages")
        return new Response("not found", { status: 404 });
      const body = await request.json();
      requestBodies.push(body);
      callCount += 1;
      const reply = await handler(body, callCount);
      if (reply.kind === "error")
        return Response.json(
          { error: { message: "scripted provider failure" } },
          { status: reply.status ?? 500 },
        );
      return reply.kind === "tools" ? toolResponse(reply.calls) : textResponse(reply);
    },
  });
  if (server.port === undefined) throw new Error("scripted mock did not bind a port");
  return {
    url: `http://127.0.0.1:${server.port}`,
    get requestBodies() {
      return requestBodies;
    },
    get callCount() {
      return callCount;
    },
    /** 停止 mock，并终止仍被 barrier 阻塞的连接。 */
    stop: async () => {
      await server.stop(true);
    },
  };
}
