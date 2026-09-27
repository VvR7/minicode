import type { ToolOutput } from "./types.ts";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

/** 在 UTF-8 字符边界截取头部或尾部，避免产生替换字符。 */
function sliceUtf8(text: string, maxBytes: number, direction: "head" | "tail"): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  if (direction === "head") {
    let end = maxBytes;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** 统一双上限截断；提示本身计入限额，已在流式阶段丢弃输出时仍显示提示。 */
function truncate(
  text: string,
  direction: "head" | "tail",
  maxLines: number,
  maxBytes: number,
  alreadyTruncated: boolean,
): ToolOutput {
  const outputBytes = Buffer.byteLength(text);
  const lines = text.split("\n");
  // 末尾换行不额外计作一行。
  if (text.endsWith("\n")) lines.pop();
  if (!alreadyTruncated && lines.length <= maxLines && outputBytes <= maxBytes) {
    return { content: text, truncated: false, outputBytes };
  }
  const marker = `[output truncated; kept ${direction}]`;
  const keptLines = Math.max(0, maxLines - 1);
  const selected = (
    direction === "head" ? lines.slice(0, keptLines) : lines.slice(-keptLines)
  ).join("\n");
  const kept = sliceUtf8(
    selected,
    Math.max(0, maxBytes - Buffer.byteLength(marker) - 1),
    direction,
  );
  return {
    content: direction === "head" ? `${kept}\n${marker}` : `${marker}\n${kept}`,
    truncated: true,
    outputBytes,
  };
}

/** read 保留前部；默认包含提示在内最多 2000 行、50 KiB。 */
export function truncateHead(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): ToolOutput {
  return truncate(text, "head", maxLines, maxBytes, false);
}

/** bash 保留尾部；可声明流式收集阶段已经丢弃了前部内容。 */
export function truncateTail(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  alreadyTruncated = false,
): ToolOutput {
  return truncate(text, "tail", maxLines, maxBytes, alreadyTruncated);
}
