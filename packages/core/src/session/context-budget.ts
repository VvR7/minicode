import { DEFAULT_LLM_CONTEXT_WINDOW_TOKENS, type Environment } from "@minicode/protocol";
import { LlmError } from "../llm/errors.ts";
import type { LlmMessage, LlmToolSchema } from "../llm/types.ts";

/** 安全预算比例：只使用 context window 的 90%，为模型输出与估算误差留余量。 */
export const CONTEXT_SAFE_RATIO = 0.9;
/** LLM_CONTEXT_WINDOW_TOKENS 的兼容默认值。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = DEFAULT_LLM_CONTEXT_WINDOW_TOKENS;
/** LLM_MAX_OUTPUT_TOKENS 的默认值。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 参与一次请求的上下文预算配置。 */
export interface ContextBudgetConfig {
  /** 模型 context window 的 token 上限，来自 LLM_CONTEXT_WINDOW_TOKENS。 */
  readonly contextWindowTokens: number;
  /** 单次输出上限，来自 LLM_MAX_OUTPUT_TOKENS（默认 8192）。 */
  readonly maxOutputTokens: number;
}

export type ContextBudgetConfigResult =
  | { readonly ok: true; readonly value: ContextBudgetConfig }
  | { readonly ok: false; readonly error: LlmError };

/**
 * 可注入的 token 估算器。默认实现按 UTF-8 字节数 / 3 向上取整，
 * 覆盖 system prompt、notes、历史消息、本轮用户消息和 tool schemas。
 */
export type ContextBudgetEstimator = (value: unknown) => number;

const encoder = new TextEncoder();

/** 默认估算器：字符串直接计字节，其余结构做确定性 JSON 序列化后计字节。 */
export const defaultContextBudgetEstimator: ContextBudgetEstimator = (value) => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return Math.ceil(encoder.encode(text).byteLength / 3);
};

/** 一次 preflight 需要计入的全部输入。 */
export interface ContextBudgetInput {
  readonly systemPrompt: string;
  readonly notes: string;
  readonly messages: readonly LlmMessage[];
  readonly userMessage: string;
  readonly toolSchemas: readonly LlmToolSchema[];
}

export interface ContextBudgetUsage {
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly safeBudgetTokens: number;
}

export type ContextBudgetCheck =
  | { readonly ok: true; readonly usage: ContextBudgetUsage }
  | {
      readonly ok: false;
      readonly code: "context_limit_exceeded";
      readonly usage: ContextBudgetUsage;
    };

/** 解析正整数环境变量；非法返回 undefined。 */
function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * 从环境变量加载上下文预算配置。
 * 两项配置均可省略以兼容已有 .env；显式配置时必须是正整数，且输出上限小于 context window。
 */
export function loadContextBudgetConfig(environment: Environment): ContextBudgetConfigResult {
  const rawContextWindow = environment.LLM_CONTEXT_WINDOW_TOKENS;
  const contextWindowTokens =
    rawContextWindow === undefined || rawContextWindow === ""
      ? DEFAULT_CONTEXT_WINDOW_TOKENS
      : parsePositiveInteger(rawContextWindow);
  if (contextWindowTokens === undefined) {
    return {
      ok: false,
      error: new LlmError(
        "config_error",
        "invalid LLM_CONTEXT_WINDOW_TOKENS (expected a positive integer)",
      ),
    };
  }

  const rawMaxOutput = environment.LLM_MAX_OUTPUT_TOKENS;
  const maxOutputTokens =
    rawMaxOutput === undefined || rawMaxOutput === ""
      ? DEFAULT_MAX_OUTPUT_TOKENS
      : parsePositiveInteger(rawMaxOutput);
  if (maxOutputTokens === undefined) {
    return {
      ok: false,
      error: new LlmError(
        "config_error",
        "invalid LLM_MAX_OUTPUT_TOKENS (expected a positive integer)",
      ),
    };
  }
  if (maxOutputTokens >= contextWindowTokens) {
    return {
      ok: false,
      error: new LlmError(
        "config_error",
        "LLM_MAX_OUTPUT_TOKENS must be smaller than LLM_CONTEXT_WINDOW_TOKENS",
      ),
    };
  }
  return { ok: true, value: { contextWindowTokens, maxOutputTokens } };
}

/** 汇总全部输入的估算 token 数。 */
export function estimateInputTokens(
  input: ContextBudgetInput,
  estimator: ContextBudgetEstimator = defaultContextBudgetEstimator,
): number {
  return (
    estimator(input.systemPrompt) +
    estimator(input.notes) +
    estimator(input.messages) +
    estimator(input.userMessage) +
    estimator(input.toolSchemas)
  );
}

/**
 * preflight 上下文预算：safeBudget = floor(contextWindow * 0.9)，
 * 当 estimatedInput + maxOutput 超过 safeBudget 时判定为超限。
 * 只做判断，不摘要、不删除、不截断历史。
 */
export function checkContextBudget(
  config: ContextBudgetConfig,
  input: ContextBudgetInput,
  estimator: ContextBudgetEstimator = defaultContextBudgetEstimator,
): ContextBudgetCheck {
  const estimatedInputTokens = estimateInputTokens(input, estimator);
  const safeBudgetTokens = Math.floor(config.contextWindowTokens * CONTEXT_SAFE_RATIO);
  const usage: ContextBudgetUsage = {
    estimatedInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    safeBudgetTokens,
  };
  if (estimatedInputTokens + config.maxOutputTokens > safeBudgetTokens) {
    return { ok: false, code: "context_limit_exceeded", usage };
  }
  return { ok: true, usage };
}
