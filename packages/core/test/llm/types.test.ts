import { describe, expect, test } from "bun:test";

import {
  LlmContentPartSchema,
  LlmFinishReasonSchema,
  LlmMessageSchema,
  LlmResponseSchema,
  LlmStreamEventSchema,
  LlmUsageSchema,
} from "../../src/llm/types.ts";

describe("LlmMessageSchema", () => {
  test("accepts a user message with text content", () => {
    const result = LlmMessageSchema.safeParse({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown fields and empty content", () => {
    expect(LlmMessageSchema.safeParse({ role: "user", content: [] }).success).toBe(false);
    expect(
      LlmMessageSchema.safeParse({
        role: "user",
        content: [{ type: "text", text: "x" }],
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("rejects an invalid role", () => {
    expect(
      LlmMessageSchema.safeParse({ role: "system", content: [{ type: "text", text: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("LlmContentPartSchema", () => {
  test("accepts tool_use and tool_result parts", () => {
    expect(
      LlmContentPartSchema.safeParse({ type: "tool_use", id: "t1", name: "read_file", input: {} })
        .success,
    ).toBe(true);
    expect(
      LlmContentPartSchema.safeParse({
        type: "tool_result",
        toolUseId: "t1",
        content: "ok",
        isError: false,
      }).success,
    ).toBe(true);
  });

  test("rejects tool_result with non-string content", () => {
    expect(
      LlmContentPartSchema.safeParse({ type: "tool_result", toolUseId: "t1", content: 42 }).success,
    ).toBe(false);
  });
});

describe("LlmUsageSchema", () => {
  test("accepts non-negative token counts", () => {
    expect(
      LlmUsageSchema.safeParse({
        inputTokens: 1,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }).success,
    ).toBe(true);
  });

  test("rejects negative or fractional tokens", () => {
    expect(
      LlmUsageSchema.safeParse({
        inputTokens: -1,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }).success,
    ).toBe(false);
    expect(
      LlmUsageSchema.safeParse({
        inputTokens: 1.5,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }).success,
    ).toBe(false);
  });
});

describe("LlmFinishReasonSchema", () => {
  test("accepts supported stop reasons", () => {
    for (const reason of ["end_turn", "tool_use", "max_tokens", "stop_sequence"]) {
      expect(LlmFinishReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  test("rejects unsupported stop reasons", () => {
    expect(LlmFinishReasonSchema.safeParse("refusal").success).toBe(false);
  });
});

describe("LlmStreamEventSchema", () => {
  test("accepts each event variant", () => {
    expect(LlmStreamEventSchema.safeParse({ type: "text_delta", text: "hi" }).success).toBe(true);
    expect(
      LlmStreamEventSchema.safeParse({
        type: "retrying",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        reason: "network",
      }).success,
    ).toBe(true);
    expect(
      LlmStreamEventSchema.safeParse({
        type: "completed",
        response: {
          text: "done",
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          finishReason: "end_turn",
        },
      }).success,
    ).toBe(true);
  });

  test("rejects empty text_delta", () => {
    expect(LlmStreamEventSchema.safeParse({ type: "text_delta", text: "" }).success).toBe(false);
  });
});

describe("LlmResponseSchema", () => {
  test("rejects a response missing usage", () => {
    expect(
      LlmResponseSchema.safeParse({ text: "x", toolCalls: [], finishReason: "end_turn" }).success,
    ).toBe(false);
  });
});
