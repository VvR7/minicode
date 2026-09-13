import { describe, expect, test } from "bun:test";

import { LlmError } from "../../src/llm/errors.ts";
import { parseSseStream, type SseEvent } from "../../src/llm/sse.ts";

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function collect(stream: AsyncIterable<SseEvent>): Promise<string[]> {
  const datas: string[] = [];
  for await (const event of stream) {
    datas.push(event.data);
  }
  return datas;
}

describe("parseSseStream", () => {
  test("extracts data fields across multiple events", async () => {
    const body = streamFrom([
      encode('event: ping\ndata: {"type":"ping"}\n\n'),
      encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    ]);
    expect(await collect(parseSseStream(body))).toEqual([
      '{"type":"ping"}',
      '{"type":"message_stop"}',
    ]);
  });

  test("handles events split across chunks", async () => {
    const full = "event: a\ndata: hello\n\nevent: b\ndata: world\n\n";
    const bytes = encode(full);
    const midpoint = Math.floor(bytes.length / 2);
    const body = streamFrom([bytes.slice(0, midpoint), bytes.slice(midpoint)]);
    expect(await collect(parseSseStream(body))).toEqual(["hello", "world"]);
  });

  test("joins multi-line data fields and trims leading space", async () => {
    const body = streamFrom([encode("data: line1\ndata:  line2\n\n")]);
    expect(await collect(parseSseStream(body))).toEqual(["line1\nline2"]);
  });

  test("skips [DONE] and empty data", async () => {
    const body = streamFrom([encode("data: [DONE]\n\ndata: ok\n\ndata:\n\n")]);
    expect(await collect(parseSseStream(body))).toEqual(["ok"]);
  });

  test("handles a trailing event without a blank line terminator", async () => {
    const body = streamFrom([encode("data: tail")]);
    expect(await collect(parseSseStream(body))).toEqual(["tail"]);
  });

  test("rejects invalid UTF-8 as invalid_response", async () => {
    const body = streamFrom([new Uint8Array([0xff, 0xfe, 0xfd])]);
    await expect(collect(parseSseStream(body))).rejects.toBeInstanceOf(LlmError);
  });
});
