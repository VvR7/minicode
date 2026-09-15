import { describe, expect, test } from "bun:test";
import type { AgentEvent, HistoryTurn, SessionSummary, TaskSnapshot } from "@minicode/protocol";
import { TuiModel } from "../src/model.ts";
import { formatStatus } from "../src/widgets/status-bar.ts";
import { LOG_KIND_COLORS } from "../src/widgets/event-log.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const turnId = "750e8400-e29b-41d4-a716-446655440001";
const summary: SessionSummary = {
  sessionId,
  mode: "chat",
  status: "idle",
  title: "Chat",
  workspaceRoot: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestSessionSequence: 0,
};
function event(
  type: AgentEvent["type"],
  payload: AgentEvent["payload"],
  sequence: number,
): AgentEvent {
  return {
    sessionId,
    runId,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    durable: true,
    type,
    payload,
  } as AgentEvent;
}
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

describe("TuiModel", () => {
  test("adds user text only after authoritative acceptance and deduplicates identity", () => {
    const model = new TuiModel();
    model.apply({ type: "session.attached", session: summary });
    const accepted = {
      type: "turn.accepted" as const,
      sessionId,
      sessionSequence: 1,
      turnId,
      runId,
      clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
      userMessage: "hello",
    };
    model.apply(accepted);
    model.apply(accepted);
    expect(model.snapshot().lines.filter((line) => line.kind === "you")).toHaveLength(1);
    expect(model.snapshot().run).toBe("running");
  });
  test("merges replay/live deltas by sequence and finalText replaces without duplication", () => {
    const model = new TuiModel();
    model.apply({ type: "run.event", event: event("llm.text_delta", { text: "Hel" }, 2) });
    model.apply({ type: "run.event", event: event("llm.text_delta", { text: "duplicate" }, 2) });
    model.apply({
      type: "run.event",
      event: event(
        "run.finished",
        { status: "succeeded", reason: "completed", finalText: "Hello", steps: 1, usage },
        3,
      ),
    });
    const assistants = model.snapshot().lines.filter((line) => line.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("[ASSISTANT] Hello");
    expect(assistants[0]?.streaming).toBe(false);
  });
  test("keeps assistant blocks in event order across tool-calling steps", () => {
    const model = new TuiModel();
    model.apply({ type: "run.event", event: event("step.started", { step: 1 }, 1) });
    model.apply({ type: "run.event", event: event("llm.text_delta", { text: "Before tools" }, 2) });
    model.apply({
      type: "run.event",
      event: event("tool.started", { toolCallId: "call-1", name: "read_file", attempt: 1 }, 3),
    });
    model.apply({
      type: "run.event",
      event: event(
        "tool.finished",
        {
          toolCallId: "call-1",
          name: "read_file",
          isError: false,
          durationMs: 1,
          outputBytes: 10,
          truncated: false,
        },
        4,
      ),
    });
    model.apply({
      type: "run.event",
      event: event("step.finished", { step: 1, outcome: "continue" }, 5),
    });
    model.apply({ type: "run.event", event: event("step.started", { step: 2 }, 6) });
    model.apply({ type: "run.event", event: event("llm.text_delta", { text: "Final" }, 7) });
    model.apply({
      type: "run.event",
      event: event(
        "run.finished",
        {
          status: "succeeded",
          reason: "completed",
          finalText: "Final answer",
          steps: 2,
          usage,
        },
        8,
      ),
    });

    expect(model.snapshot().lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "assistant:[ASSISTANT] Before tools",
      "tool:[TOOL] ▶ running read_file",
      "tool:[TOOL] ✓ completed read_file",
      "assistant:[ASSISTANT] Final answer",
      `turn:[TURN] ✓ succeeded ${runId.slice(0, 8)} (completed)`,
    ]);
  });
  test("projects model and latest context without adding noisy transcript lines", () => {
    const model = new TuiModel({ contextWindowTokens: 100_000 });
    model.apply({
      type: "run.event",
      event: event("llm.model_selected", { model: "deepseek-flash", provider: "anthropic" }, 1),
    });
    model.apply({
      type: "run.event",
      event: event(
        "llm.usage",
        {
          inputTokens: 159,
          outputTokens: 122,
          cacheReadInputTokens: 1152,
          cacheCreationInputTokens: 10,
          contextWindowTokens: 200_000,
        },
        2,
      ),
    });
    expect(model.snapshot()).toMatchObject({
      model: "deepseek-flash",
      contextUsedTokens: 1443,
      contextWindowTokens: 200_000,
    });
    expect(model.snapshot().lines).toHaveLength(0);
  });
  test("restores history with folded task graph and tool summaries", () => {
    const task: TaskSnapshot = {
      id: 1,
      subject: "Plan",
      description: "d",
      status: "completed",
      blocked: false,
      blockedBy: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const turn: HistoryTurn = {
      turnId,
      runId,
      clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
      status: "succeeded",
      reason: "completed",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      includedInContext: true,
      taskGraph: { revision: 1, tasks: [task] },
      messages: [
        {
          messageId: "u",
          turnId,
          runId,
          role: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: [{ type: "text", text: "ask" }],
        },
        {
          messageId: "a",
          turnId,
          runId,
          role: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          content: [
            { type: "tool_use", id: "tool", name: "read", input: {} },
            { type: "tool_result", toolUseId: "tool", content: "ok" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const model = new TuiModel();
    model.apply({ type: "turn.snapshot", turn });
    const text = model
      .snapshot()
      .lines.map((line) => line.text)
      .join("\n");
    expect(text).toContain("[YOU] ask");
    expect(text).toContain("[TOOL]");
    expect(text).toContain("(collapsed)");
  });
  test("updates live tasks and exposes text labels for every visual kind", () => {
    const task: TaskSnapshot = {
      id: 1,
      subject: "Build",
      description: "d",
      status: "pending",
      blocked: false,
      blockedBy: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const model = new TuiModel();
    model.apply({ type: "run.event", event: event("task.created", { revision: 1, task }, 1) });
    model.apply({
      type: "run.event",
      event: event("task.updated", { revision: 2, task: { ...task, status: "in_progress" } }, 2),
    });
    expect(model.snapshot().lines.filter((line) => line.text.startsWith("[TASK]"))).toHaveLength(1);
    expect(model.snapshot().lines[0]).toMatchObject({ kind: "task-running" });
  });
  test("switch reset isolates sessions and one-shot is read-only", () => {
    const model = new TuiModel();
    model.addError("old");
    model.reset();
    model.apply({ type: "session.attached", session: { ...summary, mode: "one_shot" } });
    expect(model.snapshot().lines).toHaveLength(0);
    expect(model.snapshot().readOnly).toBe(true);
    expect(formatStatus(model.snapshot())).toContain("read-only");
  });
  test("keeps the documented color mapping while labels carry the same semantics", () => {
    expect(LOG_KIND_COLORS).toMatchObject({
      you: "#00ffff",
      assistant: undefined,
      turn: "#ff00ff",
      "task-pending": "#e5c07b",
      "task-running": "#61afef",
      "task-completed": "#98c379",
      "task-blocked": "#b8a46a",
      tool: "#98c379",
      "tool-retry": "#e5c07b",
      "tool-error": "#e06c75",
      model: "#56b6c2",
      retry: "#e5c07b",
      usage: "#5799a8",
      error: "#ff5555",
    });
  });
});
