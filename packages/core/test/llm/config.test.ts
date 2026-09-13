import { describe, expect, test } from "bun:test";

import type { Environment } from "@minicode/protocol";
import { loadLlmConfig } from "../../src/llm/config.ts";
import { LlmError } from "../../src/llm/errors.ts";

function env(overrides: Record<string, string | undefined> = {}): Environment {
  return { ...overrides };
}

describe("loadLlmConfig", () => {
  test("loads a complete configuration", () => {
    const result = loadLlmConfig(
      env({
        LLM_API_KEY: "key",
        LLM_BASE_URL: "https://api.anthropic.com",
        LLM_MODEL: "claude-sonnet-4-6",
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        apiKey: "key",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
      },
    });
  });

  test("returns config_error listing missing keys", () => {
    const result = loadLlmConfig(env({ LLM_API_KEY: "key" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(LlmError);
      expect(result.error.code).toBe("config_error");
      expect(result.error.message).toContain("LLM_BASE_URL");
      expect(result.error.message).toContain("LLM_MODEL");
    }
  });

  test("treats empty string as missing", () => {
    const result = loadLlmConfig(
      env({
        LLM_API_KEY: "",
        LLM_BASE_URL: "https://api.anthropic.com",
        LLM_MODEL: "m",
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects an invalid base URL", () => {
    const result = loadLlmConfig(
      env({ LLM_API_KEY: "k", LLM_BASE_URL: "not-a-url", LLM_MODEL: "m" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("config_error");
    }
  });
});
