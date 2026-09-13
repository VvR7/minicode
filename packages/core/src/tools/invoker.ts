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

const DEFAULT_RETRY_DELAYS_MS = [50] as const;

export interface ToolInvokerOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
}

/** 非 ToolError 的意外异常统一视为可重试的瞬时 I/O 错误。 */
function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }
  return new ToolError("io_error", "tool call failed", true);
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

function buildResult(output: ToolOutput, isError: boolean): ToolResult {
  const bytes = new TextEncoder().encode(output.content).byteLength;
  if (bytes > MAX_TOOL_RESULT_BYTES) {
    // 工具未自行截断时，这里做兜底截断；outputBytes 记录截断前字节数。
    return {
      content: truncateUtf8(output.content, MAX_TOOL_RESULT_BYTES),
      isError,
      truncated: true,
      outputBytes: bytes,
    };
  }
  return {
    content: output.content,
    isError,
    truncated: output.truncated ?? false,
    outputBytes: output.truncated === true ? (output.outputBytes ?? bytes) : bytes,
  };
}

/** 可被 abort 中断的延迟；abort 时抛 ToolError("aborted")。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError("aborted", "tool call aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ToolError("aborted", "tool call aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** signal 一旦 abort 即 reject，用于 Promise.race 强制超时/取消生效。 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new ToolError("aborted", "tool call aborted"));
      return;
    }
    const onAbort = (): void => reject(new ToolError("aborted", "tool call aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 统一负责参数校验、10 秒超时、Abort 与 safe-to-retry 瞬时错误的有限重试。
 * 任何失败都转为 isError 的 ToolResult，绝不向调用方抛异常。
 */
export class ToolInvoker {
  readonly #registry: ToolRegistry;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(registry: ToolRegistry, options: ToolInvokerOptions = {}) {
    this.#registry = registry;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_TOOL_MAX_ATTEMPTS);
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async invoke(
    name: string,
    params: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolInvocationResult> {
    const started = performance.now();
    const duration = (): number => Math.max(0, Math.floor(performance.now() - started));

    const tool = this.#registry.get(name);
    if (tool === undefined) {
      return this.#fail(`unknown tool: ${name}`, 0, [], duration());
    }

    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) {
      return this.#fail("invalid tool parameters", 0, [], duration());
    }

    // 组合外部取消与内部超时，二者必须可区分。
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
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
          output = await Promise.race([execution, abortPromise(controller.signal)]);
        } catch (error) {
          // race 抛弃的工具 promise 若后续拒绝，需吞掉以避免 unhandled rejection。
          execution.catch(() => {});
          if (context.signal.aborted) {
            return this.#fail("tool call aborted", attempts, retries, duration());
          }
          if (timedOut) {
            return this.#fail("tool call timed out", attempts, retries, duration());
          }

          const toolError = toToolError(error);
          if (!toolError.retryable || attempt >= this.#maxAttempts) {
            return this.#fail(toolError.message, attempts, retries, duration());
          }

          const delayMs =
            this.#retryDelaysMs[Math.min(attempt - 1, this.#retryDelaysMs.length - 1)] ?? 50;
          retries.push({
            attempt: attempt + 1,
            maxAttempts: this.#maxAttempts,
            delayMs,
            errorCode: toolError.code,
          });
          try {
            await sleep(delayMs, controller.signal);
          } catch {
            return this.#fail(
              context.signal.aborted ? "tool call aborted" : "tool call timed out",
              attempts,
              retries,
              duration(),
            );
          }
          continue;
        }

        return {
          result: buildResult(output, false),
          attempts,
          retries,
          durationMs: duration(),
        };
      }
      return this.#fail("tool call failed", attempts, retries, duration());
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  #fail(
    message: string,
    attempts: number,
    retries: readonly ToolRetry[],
    durationMs: number,
  ): ToolInvocationResult {
    return {
      result: buildResult({ content: message }, true),
      attempts,
      retries,
      durationMs,
    };
  }
}
