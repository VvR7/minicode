import { LlmError } from "./errors.ts";

/** 一条 SSE 事件的 data 字段（不含 event 名，type 在 data JSON 内）。 */
export interface SseEvent {
  readonly data: string;
}

/** 从一段以空行分隔的事件块中提取 data 字段；无有效 data 时返回 undefined。 */
function extractData(block: string): string | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return data.length === 0 || data === "[DONE]" ? undefined : data;
}

/**
 * 解析 SSE 字节流为 data 字段序列。
 * Anthropic 兼容端点把事件 type 放在 data JSON 内，event 名冗余，故此处忽略。
 * 读取失败（网络中断或 abort）由 body 的 reader 抛出并原样向上传播，
 * 无效 UTF-8 则转换为 invalid_response。
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      let decoded: string;
      try {
        decoded = decoder.decode(value, { stream: true });
      } catch {
        throw new LlmError("invalid_response", "SSE stream contains invalid UTF-8");
      }
      buffer += decoded;

      // 事件以空行分隔；最后一段可能是半条事件，保留到下一批字节。
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = extractData(block);
        if (data !== undefined) {
          yield { data };
        }
      }
    }

    // 流正常结束时，处理未以空行结尾的最后一条事件。
    const tail = extractData(buffer);
    if (tail !== undefined) {
      yield { data: tail };
    }
  } finally {
    reader.releaseLock();
  }
}
