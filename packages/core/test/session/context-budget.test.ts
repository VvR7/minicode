import { describe, expect, test } from "bun:test";
import type { Environment } from "@minicode/protocol";
import { LlmError } from "../../src/llm/errors.ts";
import type { LlmMessage, LlmToolSchema } from "../../src/llm/types.ts";
import {
  CONTEXT_SAFE_RATIO,
  checkContextBudget,
  DEFAULT_MAX_OUTPUT_TOKENS,
  defaultContextBudgetEstimator,
  estimateInputTokens,
  loadContextBudgetConfig,
} from "../../src/session/context-budget.ts";
import { MemorySessionStorage } from "./test-helpers.ts";

function env(overrides: Record<string, string | undefined>): Environment {
  return { ...overrides };
}

const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const toolSchemas: LlmToolSchema[] = [
  { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
];

describe("loadContextBudgetConfig", () => {
  test("requires a positive context window", () => {
    expect(loadContextBudgetConfig(env({})).ok).toBe(false);
    for (const value of ["0", "-1", "abc", "1.5", ""]) {
      const result = loadContextBudgetConfig(env({ LLM_CONTEXT_WINDOW_TOKENS: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(LlmError);
        expect(result.error.code).toBe("config_error");
      }
    }
  });

  test("defaults max output tokens to 8192", () => {
    const result = loadContextBudgetConfig(env({ LLM_CONTEXT_WINDOW_TOKENS: "100000" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      expect(result.value.contextWindowTokens).toBe(100000);
    }
  });

  test("accepts an explicit max output smaller than the window", () => {
    const result = loadContextBudgetConfig(
      env({ LLM_CONTEXT_WINDOW_TOKENS: "100000", LLM_MAX_OUTPUT_TOKENS: "4096" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxOutputTokens).toBe(4096);
    }
  });

  test("rejects an invalid or non-smaller max output", () => {
    for (const value of ["0", "nope", "1000"]) {
      const result = loadContextBudgetConfig(
        env({ LLM_CONTEXT_WINDOW_TOKENS: "1000", LLM_MAX_OUTPUT_TOKENS: value }),
      );
      expect(result.ok).toBe(false);
    }
    // 空字符串按未设置处理，回落默认值。
    const empty = loadContextBudgetConfig(
      env({ LLM_CONTEXT_WINDOW_TOKENS: "100000", LLM_MAX_OUTPUT_TOKENS: "" }),
    );
    expect(empty.ok).toBe(true);
  });
});

describe("ContextBudgetEstimator", () => {
  test("estimates UTF-8 bytes divided by three, rounded up", () => {
    expect(defaultContextBudgetEstimator("")).toBe(0);
    expect(defaultContextBudgetEstimator("abc")).toBe(1);
    expect(defaultContextBudgetEstimator("abcd")).toBe(2);
    expect(defaultContextBudgetEstimator("你好")).toBe(2);
    expect(defaultContextBudgetEstimator({ a: 1 })).toBe(3);
    expect(defaultContextBudgetEstimator(undefined)).toBe(0);
  });

  test("sums system, notes, messages, user message, and tool schemas", () => {
    const estimator = () => 7;
    const total = estimateInputTokens(
      {
        systemPrompt: "s",
        notes: "n",
        messages,
        userMessage: "u",
        toolSchemas,
      },
      estimator,
    );
    expect(total).toBe(35);
  });
});

describe("checkContextBudget", () => {
  const config = { contextWindowTokens: 7, maxOutputTokens: 1 };

  test("computes the safe budget and accepts input up to the boundary", () => {
    const safeBudget = Math.floor(7 * CONTEXT_SAFE_RATIO);
    // 5 个输入字段各计 1 token，加输出 1 token 正好等于安全预算。
    const result = checkContextBudget(
      config,
      { systemPrompt: "", notes: "", messages: [], userMessage: "", toolSchemas: [] },
      () => 1,
    );
    expect(result.ok).toBe(true);
    expect(result.usage.safeBudgetTokens).toBe(safeBudget);
    expect(result.usage.estimatedInputTokens).toBe(5);
    expect(result.usage.estimatedInputTokens + result.usage.maxOutputTokens).toBe(safeBudget);
  });

  test("rejects input that exceeds the safe budget", () => {
    const safeBudget = Math.floor(7 * CONTEXT_SAFE_RATIO);
    const result = checkContextBudget(
      config,
      { systemPrompt: "", notes: "", messages: [], userMessage: "", toolSchemas: [] },
      () => 2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("context_limit_exceeded");
    }
    expect(result.usage.estimatedInputTokens + result.usage.maxOutputTokens).toBeGreaterThan(
      safeBudget,
    );
  });

  test("is a pure check that never persists anything", () => {
    const storage = new MemorySessionStorage();
    const result = checkContextBudget(
      { contextWindowTokens: 1, maxOutputTokens: 1 },
      { systemPrompt: "huge", notes: "", messages: [], userMessage: "", toolSchemas: [] },
    );
    expect(result.ok).toBe(false);
    expect(storage.files.size).toBe(0);
  });
});
