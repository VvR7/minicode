import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ToolError } from "./types.ts";

/** 从未知错误中安全提取 Node 错误码。 */
export function nodeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/** 把常见文件系统异常转换成稳定、默认不重试的工具错误。 */
export function toFileToolError(error: unknown, action: string): ToolError {
  if (error instanceof ToolError) return error;
  const code = nodeErrorCode(error);
  if (code === "ENOENT") return new ToolError("not_found", "file not found");
  if (code === "EACCES" || code === "EPERM") {
    return new ToolError("io_error", `${action}: permission denied`);
  }
  return new ToolError("io_error", `${action} failed`);
}

/** 检查取消信号，避免取消后继续产生文件副作用。 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError("tool_cancelled", "tool call cancelled");
}

/**
 * 解析工具路径。仅拒绝显式 `..` 路径段；绝对路径和指向 workspace 外的符号链接
 * 按 Stage3 的宽访问约定保留。
 */
export function resolveToolPath(workspaceRoot: string, inputPath: string): string {
  if (inputPath.split(/[\\/]+/u).includes("..")) {
    throw new ToolError("path_escape", "parent path segments are not allowed");
  }
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspaceRoot, inputPath);
}

/** 读取并严格解码 UTF-8 文本，同时拒绝包含 NUL 的二进制内容。 */
export async function readUtf8File(path: string): Promise<{ text: string; bytes: number }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw toFileToolError(error, "read file");
  }
  if (bytes.includes(0)) throw new ToolError("binary_file", "file appears to be binary");
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    throw new ToolError("invalid_utf8", "file is not valid UTF-8");
  }
}
