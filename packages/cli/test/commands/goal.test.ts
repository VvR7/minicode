import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@minicode/protocol";

import { GoalEventReducer, exitCodeFor, parseGoalArgs } from "../../src/commands/goal.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

/** 构造一个合法的最小 AgentEvent，覆盖 type 无关的公共字段。 */
function event(
  type: AgentEvent["type"],
  payload: AgentEvent["payload"],
  sequence: number,
): AgentEvent {
  return {
    sessionId,
    runId,
    sequence,
    timestamp: "2026-09-13T08:00:00.000Z",
    durable: true,
    type,
    payload,
  } as AgentEvent;
}

describe("parseGoalArgs", () => {
  test("parses --goal with a separate value", () => {
    expect(parseGoalArgs(["--goal", "summarize the repo"])).toEqual({
      ok: true,
      goal: "summarize the repo",
    });
  });

  test("parses --goal=value form", () => {
    expect(parseGoalArgs(["--goal=summarize"])).toEqual({ ok: true, goal: "summarize" });
  });

  test("trims surrounding whitespace", () => {
    expect(parseGoalArgs(["--goal", "  hello  "])).toEqual({ ok: true, goal: "hello" });
  });

  test("rejects a missing goal", () => {
    expect(parseGoalArgs([]).ok).toBe(false);
    expect(parseGoalArgs(["--goal", ""]).ok).toBe(false);
  });

  test("rejects --goal without a value", () => {
    expect(parseGoalArgs(["--goal"]).ok).toBe(false);
  });

  test("rejects unknown arguments", () => {
    expect(parseGoalArgs(["--unknown"]).ok).toBe(false);
  });
});

describe("GoalEventReducer", () => {
  test("routes assistant text to stdout and progress to stderr", () => {
    const reducer = new GoalEventReducer();
    const text = reducer.onEvent(event("llm.text_delta", { text: "Hello" }, 1));
    const step = reducer.onEvent(event("step.started", { step: 1 }, 2));
    const tool = reducer.onEvent(
      event("tool.started", { toolCallId: "t1", name: "read_file", attempt: 1 }, 3),
    );

    expect(text.stdout).toBe("Hello");
    expect(text.stderr).toEqual([]);
    expect(step.stderr).toEqual(["step 1"]);
    expect(tool.stderr).toEqual(["tool read_file"]);
  });

  test("drops duplicate sequences during replay", () => {
    const reducer = new GoalEventReducer();
    const first = reducer.onEvent(event("llm.text_delta", { text: "A" }, 1));
    const duplicate = reducer.onEvent(event("llm.text_delta", { text: "A" }, 1));
    const next = reducer.onEvent(event("llm.text_delta", { text: "B" }, 2));

    expect(first.stdout).toBe("A");
    expect(duplicate.stdout).toBeUndefined();
    expect(next.stdout).toBe("B");
    expect(reducer.lastSequence).toBe(2);
  });

  test("records the terminal outcome from run.finished", () => {
    const reducer = new GoalEventReducer();
    reducer.onEvent(
      event(
        "run.finished",
        {
          status: "succeeded",
          reason: "completed",
          finalText: "done",
          steps: 2,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
        5,
      ),
    );

    expect(reducer.outcome).toEqual({
      status: "succeeded",
      reason: "completed",
      finalText: "done",
      steps: 2,
    });
  });
});

describe("exitCodeFor", () => {
  test("maps success, failure, and cancellation", () => {
    const base = { finalText: "", steps: 1 };
    expect(exitCodeFor({ ...base, status: "succeeded", reason: "completed" }, false)).toBe(0);
    expect(exitCodeFor({ ...base, status: "failed", reason: "llm_error" }, false)).toBe(1);
    expect(exitCodeFor({ ...base, status: "cancelled", reason: "cancelled" }, true)).toBe(130);
    expect(exitCodeFor({ ...base, status: "cancelled", reason: "cancelled" }, false)).toBe(1);
  });

  test("treats a missing outcome as a run failure", () => {
    expect(exitCodeFor(undefined, false)).toBe(1);
  });
});
