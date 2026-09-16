import type { PermissionSource, ToolFailureCategory } from "@minicode/protocol";
import type { z } from "zod";

/** 单个工具结果的内容上限，超出部分截断并标记 truncated。 */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
/** 工具调用的默认超时毫秒数。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
/** 工具调用的默认最大尝试次数。 */
export const DEFAULT_TOOL_MAX_ATTEMPTS = 3;

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
  /** 失败时提供给事件层和模型的稳定分类。 */
  readonly failure?: ToolFailure;
}

/** 工具失败的公开分类与稳定错误码。 */
export interface ToolFailure {
  readonly category: ToolFailureCategory;
  readonly errorCode: string;
}

/** 工具错误码。 */
export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_params"
  | "path_escape"
  | "not_found"
  | "binary_file"
  | "invalid_utf8"
  | "tool_timeout"
  | "tool_cancelled"
  | "permission_denied"
  | "command_failed"
  | "no_match"
  | "ambiguous_match"
  | "io_error"
  | "temporary_io_error"
  | "rate_limited";

/**
 * 工具领域错误。工具 execute 抛出它表示失败，
 * ToolInvoker 统一转换为 isError 的 ToolResult observation，不向调用方抛异常。
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly category: ToolFailureCategory;
  readonly retryable: boolean;
  readonly output: ToolOutput | undefined;

  /** 创建带公开分类和重试属性的工具领域错误。 */
  constructor(
    code: ToolErrorCode,
    message: string,
    options:
      | {
          readonly category?: ToolFailureCategory;
          readonly retryable?: boolean;
          readonly output?: ToolOutput;
        }
      | boolean = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.category =
      typeof options === "boolean"
        ? defaultFailureCategory(code)
        : (options.category ?? defaultFailureCategory(code));
    this.retryable =
      typeof options === "boolean" ? options : (options.retryable ?? defaultRetryable(code));
    this.output = typeof options === "boolean" ? undefined : options.output;
  }
}

/** 只有显式瞬时运行时错误和上游限速默认允许重试。 */
function defaultRetryable(code: ToolErrorCode): boolean {
  return code === "temporary_io_error" || code === "rate_limited";
}

/** 按稳定错误码推导默认公开失败分类。 */
function defaultFailureCategory(code: ToolErrorCode): ToolFailureCategory {
  switch (code) {
    case "unknown_tool":
    case "invalid_params":
    case "path_escape":
      return "schema_error";
    case "permission_denied":
      return "permission_denied";
    case "tool_timeout":
      return "timeout";
    case "tool_cancelled":
      return "cancelled";
    case "rate_limited":
      return "rate_limited";
    default:
      return "runtime_error";
  }
}

/** 一次工具重试的描述，供上层发布 tool.retrying 事件。 */
export interface ToolRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorCode: ToolErrorCode;
  readonly failureCategory: ToolFailureCategory;
}

/** ToolInvoker.invoke 的完整结果，包含重试与耗时信息。 */
export interface ToolInvocationResult {
  readonly result: ToolResult;
  readonly attempts: number;
  readonly retries: readonly ToolRetry[];
  readonly durationMs: number;
  readonly permissionSource?: PermissionSource;
}

/** 工具产出：内容 + 可选的截断信息。 */
export interface ToolOutput {
  readonly content: string;
  /** 工具自身已截断（如 read/bash 输出过大）时置 true。 */
  readonly truncated?: boolean;
  /** 工具已截断时提供截断前的原始字节数。 */
  readonly outputBytes?: number;
}

/**
 * 工具的抽象契约。inputSchema 是参数的运行时边界，
 * registry 通过 z.toJSONSchema 导出 LLM JSON Schema。
 */
export interface Tool<Params = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Params>;
  /** 返回该次调用的执行超时；省略时使用统一 10 秒。 */
  timeoutMs?(params: Params): number;
  /** 返回产出；失败抛 ToolError。 */
  execute(params: Params, context: ToolExecutionContext): Promise<ToolOutput> | ToolOutput;
}
