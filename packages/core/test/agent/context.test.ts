import { describe, expect, test } from "bun:test";
import { ExecutionContext, DEFAULT_MAX_STEPS } from "../../src/agent/context.ts";
import { SESSION_A, SESSION_B, RUN_A, RUN_B } from "./test-helpers.ts";

function makeContext(overrides: Partial<ConstructorParameters<typeof ExecutionContext>[0]> = {}) {
  return new ExecutionContext({
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceRoot: "/workspace",
    goal: "summarize the repo",
    ...overrides,
  });
}

describe("ExecutionContext", () => {
  test("starts running with the goal as the first user message", () => {
    const context = makeContext();
    expect(context.status).toBe("running");
    expect(context.step).toBe(0);
    expect(context.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "summarize the repo" }] },
    ]);
    expect(context.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  test("defaults main maxSteps to 200 and honors overrides", () => {
    expect(makeContext().maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(DEFAULT_MAX_STEPS).toBe(200);
    expect(makeContext({ maxSteps: 3 }).maxSteps).toBe(3);
  });

  test("adds assistant messages and merges tool results into one user message", () => {
    const context = makeContext();
    context.addAssistantMessage([{ type: "text", text: "let me check" }]);
    context.addToolResults([
      { toolUseId: "t1", content: "one", isError: false },
      { toolUseId: "t2", content: "boom", isError: true },
    ]);

    expect(context.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "let me check" }],
    });
    expect(context.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "t1", content: "one" },
        { type: "tool_result", toolUseId: "t2", content: "boom", isError: true },
      ],
    });
  });

  test("skips empty assistant messages and empty tool result batches", () => {
    const context = makeContext();
    context.addAssistantMessage([]);
    context.addToolResults([]);
    expect(context.messages).toHaveLength(1);
  });

  test("accumulates usage across calls", () => {
    const context = makeContext();
    context.accumulateUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
    });
    context.accumulateUsage({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(context.usage).toEqual({
      inputTokens: 13,
      outputTokens: 9,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
    });
  });

  test("transitions through terminal states with reasons", () => {
    const succeeded = makeContext();
    succeeded.markSucceeded("final answer");
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.reason).toBeUndefined();
    expect(succeeded.finalText).toBe("final answer");
    expect(succeeded.isDone()).toBe(true);

    const failed = makeContext();
    failed.markFailed("max_steps");
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("max_steps");

    const cancelled = makeContext();
    cancelled.markCancelled();
    expect(cancelled.status).toBe("cancelled");
  });

  test("keeps mutable state isolated between two contexts", () => {
    const first = makeContext({ sessionId: SESSION_A, runId: RUN_A });
    const second = makeContext({ sessionId: SESSION_B, runId: RUN_B });

    first.addAssistantMessage([{ type: "text", text: "a" }]);
    first.accumulateUsage({
      inputTokens: 1,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    first.markSucceeded("done");

    expect(second.messages).toHaveLength(1);
    expect(second.status).toBe("running");
    expect(second.usage.inputTokens).toBe(0);
    expect(second.finalText).toBe("");
  });
});
