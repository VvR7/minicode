import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Dirent, Stats } from "node:fs";
import { ToolError } from "./types.ts";

/** 从未知错误中安全提取 Node 错误码。 */
function errorCode(error: unknown): string | undefined {
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

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnreadable(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolError("aborted", "tool call aborted");
  }
}

/** 检测字节是否包含 NUL，作为 binary 文件的启发式判断。 */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** 词法检查 + realpath 边界：拒绝绝对路径、.. 逃逸与 symlink 逃逸。 */
export async function resolveSafePath(workspaceRoot: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new ToolError("path_escape", "absolute paths are not allowed");
  }
  const resolved = resolve(workspaceRoot, inputPath);
  const rel = relative(workspaceRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError("path_escape", "path escapes the workspace");
  }

  // realpath 解析 symlink 并校验最终落在 workspace 内；目标不存在时交给调用方处理。
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(workspaceRoot);
    realTarget = await realpath(resolved);
  } catch (error) {
    if (isNotFound(error)) {
      return resolved;
    }
    throw new ToolError("io_error", "failed to resolve path", true);
  }
  const relReal = relative(realRoot, realTarget);
  if (relReal === ".." || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) {
    throw new ToolError("path_escape", "path resolves outside the workspace");
  }
  return realTarget;
}

/**
 * 递归遍历目录下的普通文件，返回相对 root 的路径列表。
 * 跳过 symlink（防逃逸）与不可读目录，尊重 AbortSignal。
 */
export async function walkFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files, signal);
  // 排序保证输出确定性，便于测试与 LLM 消费。
  return files.sort();
}

async function walk(
  base: string,
  dir: string,
  files: string[],
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error) || isUnreadable(error)) {
      return;
    }
    throw new ToolError("io_error", "failed to read directory", true);
  }
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(base, full, files, signal);
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
}

export interface TextFileContent {
  readonly text: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

/**
 * 读取文本文件：检测 binary 与无效 UTF-8，只读取前 limitBytes 字节。
 * stream 解码避免截断位置的多字节序列被误判为无效 UTF-8。
 */
export async function readTextFileSafe(path: string, limitBytes: number): Promise<TextFileContent> {
  // O_NOFOLLOW + 同一 FileHandle 的 fstat/read 消除 realpath 校验与实际读取之间的末端 symlink 竞态。
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error)) {
      throw new ToolError("not_found", "file not found");
    }
    throw new ToolError("io_error", "failed to read file", true);
  }
  try {
    const info: Stats = await handle.stat();
    if (!info.isFile()) {
      throw new ToolError("invalid_params", "path does not refer to a file");
    }
    const bytes = new Uint8Array(Math.min(info.size, limitBytes));
    await handle.read(bytes, 0, bytes.byteLength, 0);
    if (isBinary(bytes)) {
      throw new ToolError("binary_file", "file appears to be binary");
    }
    let text: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      text = decoder.decode(bytes, { stream: true }) + decoder.decode();
    } catch {
      throw new ToolError("invalid_utf8", "file is not valid UTF-8");
    }
    return { text, outputBytes: info.size, truncated: info.size > limitBytes };
  } finally {
    await handle.close();
  }
}
