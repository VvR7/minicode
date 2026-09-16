import {
  DEFAULT_TOOL_MAX_ATTEMPTS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_BYTES,
  ToolError,
  type ToolExecutionContext,
  type ToolInvocationResult,
  type ToolOutput,
  type ToolResult,
  type ToolRetry,
} from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000] as const;

export interface ToolInvokerOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
}

export interface ToolInvocationOptions {
  readonly permissionSource?: "policy" | "session_cache" | "user";
  readonly onRetry?: (retry: ToolRetry) => Promise<void> | void;
}

/** 非 ToolError 的意外异常不可证明可安全重试，避免重复执行有副作用的工具。 */
function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }
  return new ToolError("io_error", "tool call failed");
}

/** 防止 schema、权限、超时、取消等类别被误标后进入重试。 */
function canRetry(error: ToolError): boolean {
  return (
    error.retryable && (error.category === "runtime_error" || error.category === "rate_limited")
  );
}

/** 把字符串内容安全截断到 maxBytes，不在多字节 UTF-8 字符中间切断。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, cut));
}

function buildResult(
  output: ToolOutput,
  isError: boolean,
  failure?: ToolResult["failure"],
): ToolResult {
  const bytes = new TextEncoder().encode(output.content).byteLength;
  if (bytes > MAX_TOOL_RESULT_BYTES) {
    // 工具未自行截断时，这里做兜底截断；outputBytes 记录截断前字节数。
    return {
      content: truncateUtf8(output.content, MAX_TOOL_RESULT_BYTES),
      isError,
      truncated: true,
      outputBytes: bytes,
      ...(failure === undefined ? {} : { failure }),
    };
  }
  return {
    content: output.content,
    isError,
    truncated: output.truncated ?? false,
    outputBytes: output.truncated === true ? (output.outputBytes ?? bytes) : bytes,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** 可被 abort 中断的延迟；abort 时抛取消错误。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError("tool_cancelled", "tool call cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ToolError("tool_cancelled", "tool call cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 等待一次执行并在 signal abort 时拒绝，结束后移除监听器。 */
function executeWithAbort<T>(execution: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError("tool_cancelled", "tool call cancelled"));
      return;
    }
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new ToolError("tool_cancelled", "tool call cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    execution.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * 统一负责参数校验、工具专用/默认 10 秒超时、Abort 与瞬时错误的有限重试。
 * 任何工具失败都转为 isError 的 ToolResult，基础设施回调失败仍向上抛出。
 */
export class ToolInvoker {
  readonly #registry: ToolRegistry;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelaysMs: readonly number[];

  /** 保存注册表及统一超时、尝试次数和退避配置。 */
  constructor(registry: ToolRegistry, options: ToolInvokerOptions = {}) {
    this.#registry = registry;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxAttempts = Math.min(3, Math.max(1, options.maxAttempts ?? DEFAULT_TOOL_MAX_ATTEMPTS));
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** 校验参数后执行工具，把可预期失败归一化为模型可见 observation。 */
  async invoke(
    name: string,
    params: unknown,
    context: ToolExecutionContext,
    options: ToolInvocationOptions = {},
  ): Promise<ToolInvocationResult> {
    const started = performance.now();
    const duration = (): number => Math.max(0, Math.floor(performance.now() - started));

    const tool = this.#registry.get(name);
    if (tool === undefined) {
      return this.#fail(new ToolError("unknown_tool", `unknown tool: ${name}`), 0, [], duration());
    }

    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) {
      return this.#fail(
        new ToolError("invalid_params", "invalid tool parameters"),
        0,
        [],
        duration(),
      );
    }
    // 在创建执行 promise 前退出，确保已取消的 run 不会实际调用工具。
    if (context.signal.aborted) {
      return this.#fail(new ToolError("tool_cancelled", "tool call cancelled"), 0, [], duration());
    }

    // 组合外部取消与内部超时，二者必须可区分。
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    const timeoutMs = tool.timeoutMs?.(parsed.data) ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (context.signal.aborted) {
      controller.abort();
    } else {
      context.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const retries: ToolRetry[] = [];
    let attempts = 0;

    try {
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        attempts = attempt;
        const execution = Promise.resolve().then(() =>
          tool.execute(parsed.data, {
            workspaceRoot: context.workspaceRoot,
            signal: controller.signal,
          }),
        );

        let output: ToolOutput;
        try {
          // 用 race 强制超时/取消生效，不依赖工具是否响应 signal。
          output = await executeWithAbort(execution, controller.signal);
        } catch (error) {
          // race 抛弃的工具 promise 若后续拒绝，需吞掉以避免 unhandled rejection。
          execution.catch(() => {});
          if (context.signal.aborted) {
            return this.#fail(
              new ToolError("tool_cancelled", "tool call cancelled"),
              attempts,
              retries,
              duration(),
              options.permissionSource ?? "policy",
            );
          }
          if (timedOut) {
            return this.#fail(
              new ToolError("tool_timeout", "tool call timed out"),
              attempts,
              retries,
              duration(),
              options.permissionSource ?? "policy",
            );
          }

          const toolError = toToolError(error);
          if (!canRetry(toolError) || attempt >= this.#maxAttempts) {
            return this.#fail(
              toolError,
              attempts,
              retries,
              duration(),
              options.permissionSource ?? "policy",
            );
          }

          const delayMs =
            this.#retryDelaysMs[Math.min(attempt - 1, this.#retryDelaysMs.length - 1)] ?? 4_000;
          const retry = {
            attempt: attempt + 1,
            maxAttempts: this.#maxAttempts,
            delayMs,
            errorCode: toolError.code,
            failureCategory: toolError.category,
          } satisfies ToolRetry;
          retries.push(retry);
          await options.onRetry?.(retry);
          try {
            await sleep(delayMs, controller.signal);
          } catch {
            return this.#fail(
              context.signal.aborted
                ? new ToolError("tool_cancelled", "tool call cancelled")
                : new ToolError("tool_timeout", "tool call timed out"),
              attempts,
              retries,
              duration(),
              options.permissionSource ?? "policy",
            );
          }
          continue;
        }

        return {
          result: buildResult(output, false),
          attempts,
          retries,
          durationMs: duration(),
          permissionSource: options.permissionSource ?? "policy",
        };
      }
      return this.#fail(
        new ToolError("io_error", "tool call failed"),
        attempts,
        retries,
        duration(),
        options.permissionSource ?? "policy",
      );
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 构造带稳定失败分类的终态调用结果。 */
  #fail(
    error: ToolError,
    attempts: number,
    retries: readonly ToolRetry[],
    durationMs: number,
    permissionSource?: "policy" | "session_cache" | "user",
  ): ToolInvocationResult {
    return {
      result: buildResult(error.output ?? { content: error.message }, true, {
        category: error.category,
        errorCode: error.code,
      }),
      attempts,
      retries,
      durationMs,
      ...(permissionSource === undefined ? {} : { permissionSource }),
    };
  }
}
