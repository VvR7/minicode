import type { z } from "zod";

/** 单个工具结果的内容上限，超出部分截断并标记 truncated。 */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
/** 工具调用的默认超时毫秒数。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
/** 工具调用的默认最大尝试次数。 */
export const DEFAULT_TOOL_MAX_ATTEMPTS = 2;

/** 工具执行时的隔离上下文。 */
export interface ToolExecutionContext {
  /** 已 realpath 化的 workspace 绝对路径。 */
  readonly workspaceRoot: string;
  /** 调用方取消信号；工具应在读取前检查并响应。 */
  readonly signal: AbortSignal;
}

/** 归一化后的工具结果；由 ToolInvoker 统一生成，工具只返回文本内容。 */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly truncated: boolean;
  readonly outputBytes: number;
}

/** 工具错误码。 */
export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_params"
  | "path_escape"
  | "not_found"
  | "binary_file"
  | "invalid_utf8"
  | "timeout"
  | "aborted"
  | "io_error";

/**
 * 工具领域错误。工具 execute 抛出它表示失败，
 * ToolInvoker 统一转换为 isError 的 ToolResult observation，不向调用方抛异常。
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;

  constructor(code: ToolErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 一次工具重试的描述，供上层发布 tool.retrying 事件。 */
export interface ToolRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorCode: ToolErrorCode;
}

/** ToolInvoker.invoke 的完整结果，包含重试与耗时信息。 */
export interface ToolInvocationResult {
  readonly result: ToolResult;
  readonly attempts: number;
  readonly retries: readonly ToolRetry[];
  readonly durationMs: number;
}

/** 工具产出：内容 + 可选的截断信息。 */
export interface ToolOutput {
  readonly content: string;
  /** 工具自身已截断（如 read_file 读取超大文件）时置 true。 */
  readonly truncated?: boolean;
  /** 工具已截断时提供截断前的原始字节数。 */
  readonly outputBytes?: number;
}

/**
 * 只读工具的抽象契约。inputSchema 是参数的运行时边界，
 * registry 通过 z.toJSONSchema 导出 LLM JSON Schema。
 */
export interface Tool<Params = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Params>;
  /** 返回产出；失败抛 ToolError。 */
  execute(params: Params, context: ToolExecutionContext): Promise<ToolOutput> | ToolOutput;
}
