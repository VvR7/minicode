import type { PermissionManager } from "../permissions/manager.ts";
import type { PermissionScope } from "../permissions/policy.ts";
import type { PermissionMode } from "../config.ts";
import { RUNTIME_CONFIG } from "../runtime-config.ts";
import type { ToolRegistry } from "./registry.ts";
import {
  DEFAULT_TOOL_MAX_ATTEMPTS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_BYTES,
  ToolError,
  type Tool,
  type ToolExecutionContext,
  type ToolInvocationResult,
  type ToolOutput,
  type ToolResult,
  type ToolRetry,
} from "./types.ts";

const DEFAULT_RETRY_DELAYS_MS = RUNTIME_CONFIG.tool.retryDelaysMs;

export interface ToolInvokerOptions {
  readonly permissions?: PermissionManager;
  readonly permissionMode?: PermissionMode;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
}

export interface ToolInvocationOptions {
  readonly permissionScope?: PermissionScope;
  readonly permissionSource?: "policy" | "session_cache" | "user";
  readonly onRetry?: (retry: ToolRetry) => Promise<void> | void;
}

/** 准备结果固定已校验参数与审批决定，执行阶段不再重复审批。 */
export type PreparedToolInvocation =
  | { readonly kind: "finished"; readonly invocation: ToolInvocationResult }
  | {
      readonly kind: "ready";
      readonly tool: Tool;
      readonly params: Record<string, unknown>;
      readonly context: ToolExecutionContext;
      readonly options: ToolInvocationOptions;
      readonly permissionSource: "policy" | "session_cache" | "user";
      readonly startedAt: number;
    };

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
  readonly #permissions: PermissionManager | undefined;
  readonly #permissionMode: PermissionMode;

  /** 保存注册表及统一超时、尝试次数和退避配置。 */
  constructor(registry: ToolRegistry, options: ToolInvokerOptions = {}) {
    this.#registry = registry;
    this.#permissions = options.permissions;
    this.#permissionMode = options.permissionMode ?? "alwaysask";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxAttempts = Math.min(
      RUNTIME_CONFIG.tool.maxAttempts,
      Math.max(1, options.maxAttempts ?? DEFAULT_TOOL_MAX_ATTEMPTS),
    );
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** 兼容单次调用入口：准备后立即执行，保留原有校验与审批次序。 */
  async invoke(
    name: string,
    params: unknown,
    context: ToolExecutionContext,
    options: ToolInvocationOptions = {},
  ): Promise<ToolInvocationResult> {
    return this.executePrepared(await this.prepare(name, params, context, options));
  }

  /** 只完成参数校验与审批，不创建执行 Promise 或执行超时定时器。 */
  async prepare(
    name: string,
    params: unknown,
    context: ToolExecutionContext,
    options: ToolInvocationOptions = {},
  ): Promise<PreparedToolInvocation> {
    const startedAt = performance.now();
    const failed = (
      error: ToolError,
      permissionSource?: "policy" | "session_cache" | "user",
    ): PreparedToolInvocation => ({
      kind: "finished",
      invocation: this.#fail(
        error,
        0,
        [],
        Math.max(0, Math.floor(performance.now() - startedAt)),
        permissionSource,
      ),
    });
    const tool = this.#registry.get(name);
    if (tool === undefined) return failed(new ToolError("unknown_tool", `unknown tool: ${name}`));
    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) return failed(new ToolError("invalid_params", "invalid tool parameters"));
    if (context.signal.aborted)
      return failed(new ToolError("tool_cancelled", "tool call cancelled"));
    let permissionSource = options.permissionSource ?? "policy";
    if (this.#permissions !== undefined) {
      if (options.permissionScope === undefined) throw new Error("permission scope required");
      try {
        const outcome = await this.#permissions.check(
          name,
          parsed.data,
          options.permissionScope,
          context.signal,
          this.#permissionMode,
        );
        permissionSource = outcome.source;
        if (!outcome.allowed)
          return failed(
            new ToolError("permission_denied", "tool permission denied"),
            permissionSource,
          );
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return failed(error);
      }
    }
    if (context.signal.aborted)
      return failed(new ToolError("tool_cancelled", "tool call cancelled"), permissionSource);
    return {
      kind: "ready",
      tool,
      params: parsed.data,
      context,
      options,
      permissionSource,
      startedAt,
    };
  }

  /** 执行已批准调用；超时从实际执行开始计时，取消后不再调用工具。 */
  async executePrepared(prepared: PreparedToolInvocation): Promise<ToolInvocationResult> {
    if (prepared.kind === "finished") return prepared.invocation;
    const { tool, params, context, options, permissionSource, startedAt } = prepared;
    const duration = (): number => Math.max(0, Math.floor(performance.now() - startedAt));
    if (context.signal.aborted)
      return this.#fail(
        new ToolError("tool_cancelled", "tool call cancelled"),
        0,
        [],
        duration(),
        permissionSource,
      );
    // 组合外部取消与内部超时，二者必须可区分。
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    // null 是显式无限等待，不能用 ?? 把它还原成默认超时。
    const requestedTimeout = tool.timeoutMs?.(params);
    const timeoutMs = requestedTimeout === undefined ? this.#timeoutMs : requestedTimeout;
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
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
        const execution = Promise.resolve().then(() => {
          // 并行批次可能在 Promise 排队后取消，调用副作用前再次检查。
          if (controller.signal.aborted)
            throw new ToolError("tool_cancelled", "tool call cancelled");
          return tool.execute(params, {
            workspaceRoot: context.workspaceRoot,
            signal: controller.signal,
          });
        });

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
              permissionSource,
            );
          }
          if (timedOut) {
            return this.#fail(
              new ToolError("tool_timeout", "tool call timed out"),
              attempts,
              retries,
              duration(),
              permissionSource,
            );
          }

          const toolError = toToolError(error);
          if (!canRetry(toolError) || attempt >= this.#maxAttempts) {
            return this.#fail(toolError, attempts, retries, duration(), permissionSource);
          }

          const delayMs =
            this.#retryDelaysMs[Math.min(attempt - 1, this.#retryDelaysMs.length - 1)] ??
            RUNTIME_CONFIG.tool.retryDelaysMs.at(-1) ??
            0;
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
              permissionSource,
            );
          }
          continue;
        }

        return {
          result: buildResult(output, false),
          attempts,
          retries,
          durationMs: duration(),
          permissionSource,
        };
      }
      return this.#fail(
        new ToolError("io_error", "tool call failed"),
        attempts,
        retries,
        duration(),
        permissionSource,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
