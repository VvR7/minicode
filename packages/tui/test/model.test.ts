import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@minicode/protocol";

import { TuiModel, decideQuit, exitCodeForRunState, shortId } from "../src/model.ts";
import { formatStatus } from "../src/widgets/status-bar.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

/** 构造一个合法的最小 AgentEvent。 */
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

function finishedPayload(status: "succeeded" | "failed" | "cancelled", finalText: string) {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const base = { finalText, steps: 1, usage };
  if (status === "succeeded") {
    return { ...base, status: "succeeded", reason: "completed" } as const;
  }
  if (status === "cancelled") {
    return { ...base, status: "cancelled", reason: "cancelled" } as const;
  }
  return { ...base, status: "failed", reason: "config_error" } as const;
}

describe("TuiModel", () => {
  test("maps run.started, model_selected and assistant deltas into lines", () => {
    const model = new TuiModel();
    model.applyStatus({ state: "connected" });

    let mutations = model.applyEvent(event("run.started", {}, 1));
    expect(mutations[0]).toMatchObject({ type: "append", line: { kind: "info" } });
    expect(model.snapshot().run).toEqual({ status: "running" });
    expect(model.snapshot().runId).toBe(runId);

    model.applyEvent(event("llm.model_selected", { model: "m", provider: "p" }, 2));
    mutations = model.applyEvent(event("llm.text_delta", { text: "Hello" }, 3));
    expect(mutations[0]).toMatchObject({ type: "append", line: { kind: "assistant", text: "" } });
    mutations = model.applyEvent(event("llm.text_delta", { text: " world" }, 4));
    expect(mutations[0]).toMatchObject({
      type: "update",
      line: { kind: "assistant", text: "Hello world" },
    });
  });

  test("starts a new assistant line on step.started", () => {
    const model = new TuiModel();
    model.applyEvent(event("llm.text_delta", { text: "a" }, 1));
    model.applyEvent(event("step.started", { step: 2 }, 2));
    const mutations = model.applyEvent(event("llm.text_delta", { text: "b" }, 3));

    expect(mutations[0]).toMatchObject({ type: "append", line: { kind: "assistant", text: "" } });
    // 两条独立的 assistant 行，而不是把 b 拼到 a 上。
    expect(
      model
        .snapshot()
        .lines.filter((l) => l.kind === "assistant")
        .map((l) => l.text),
    ).toEqual(["a", "b"]);
  });

  test("maps tool, retry and usage events", () => {
    const model = new TuiModel();
    const toolStarted = model.applyEvent(
      event("tool.started", { toolCallId: "t1", name: "read_file", attempt: 1 }, 1),
    );
    expect(toolStarted[0]).toMatchObject({ line: { kind: "tool", text: "tool read_file" } });

    const toolDone = model.applyEvent(
      event(
        "tool.finished",
        {
          toolCallId: "t1",
          name: "read_file",
          isError: false,
          durationMs: 1,
          outputBytes: 3,
          truncated: false,
        },
        2,
      ),
    );
    expect(toolDone[0]).toMatchObject({ line: { kind: "tool", text: "tool read_file done 3B" } });

    const retry = model.applyEvent(
      event("llm.retrying", { attempt: 2, maxAttempts: 3, delayMs: 0, reason: "network" }, 3),
    );
    expect(retry[0]).toMatchObject({ line: { kind: "retry" } });

    const usage = model.applyEvent(
      event(
        "llm.usage",
        { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        4,
      ),
    );
    expect(usage[0]).toMatchObject({ line: { kind: "usage", text: "usage in=1 out=2" } });
  });

  test("maps step.finished and tool.retrying events", () => {
    const model = new TuiModel();
    const step = model.applyEvent(event("step.finished", { step: 1, outcome: "continue" }, 1));
    const toolRetry = model.applyEvent(
      event(
        "tool.retrying",
        {
          toolCallId: "t1",
          name: "read_file",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 10,
          errorCode: "temporary",
        },
        2,
      ),
    );

    expect(step[0]).toMatchObject({ line: { kind: "info", text: "step 1 continue" } });
    expect(toolRetry[0]).toMatchObject({ line: { kind: "retry" } });
  });

  test("fills missing finalText suffix from the durable terminal event", () => {
    const model = new TuiModel();
    model.applyEvent(event("step.started", { step: 1 }, 1));
    model.applyEvent(event("llm.text_delta", { text: "Hel" }, 2));

    const mutations = model.applyEvent(
      event("run.finished", finishedPayload("succeeded", "Hello"), 4),
    );

    // 补齐 "lo" 并追加 run-ok 行。
    expect(mutations.some((m) => m.type === "update" && m.line.text === "Hello")).toBe(true);
    expect(mutations.at(-1)).toMatchObject({ type: "append", line: { kind: "run-ok" } });
    expect(model.snapshot().run).toEqual({ status: "finished", outcome: "succeeded" });
  });

  test("replaces a corrupted streamed line when middle deltas were lost", () => {
    const model = new TuiModel();
    model.applyEvent(event("step.started", { step: 1 }, 1));
    model.applyEvent(event("llm.text_delta", { text: "Hel" }, 2));
    model.applyEvent(event("llm.text_delta", { text: "world" }, 4));

    const mutations = model.applyEvent(
      event("run.finished", finishedPayload("succeeded", "Hello world"), 5),
    );

    expect(
      mutations.some(
        (mutation) => mutation.type === "update" && mutation.line.text === "Hello world",
      ),
    ).toBe(true);
    expect(model.snapshot().lines.find((line) => line.kind === "assistant")?.text).toBe(
      "Hello world",
    );
  });

  test("creates an assistant line from finalText when replay has no live deltas", () => {
    const model = new TuiModel();
    const mutations = model.applyEvent(
      event("run.finished", finishedPayload("succeeded", "replayed"), 1),
    );
    expect(mutations.some((m) => m.type === "append" && m.line.text === "replayed")).toBe(true);
  });

  test("maps a failed terminal event to run-fail", () => {
    const model = new TuiModel();
    const payload = {
      status: "failed" as const,
      reason: "config_error" as const,
      finalText: "",
      steps: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
    model.applyEvent(event("run.finished", payload, 1));
    expect(model.snapshot().run).toEqual({ status: "finished", outcome: "failed" });
    expect(model.snapshot().lines.at(-1)).toMatchObject({ kind: "run-fail" });
  });

  test("strictly caps one active assistant line by UTF-8 bytes", () => {
    const model = new TuiModel({ maxBytes: 8 });
    model.applyEvent(event("llm.text_delta", { text: "12😀567890" }, 1));

    const assistant = model.snapshot().lines.find((line) => line.kind === "assistant");
    expect(new TextEncoder().encode(assistant?.text ?? "").length).toBeLessThanOrEqual(8);
    expect(assistant?.text.endsWith("7890")).toBe(true);
  });

  test("maps client-side cancellation to a terminal cancelled state", () => {
    const model = new TuiModel();
    model.applyClientResult({ kind: "cancelled" });

    expect(model.snapshot().run).toEqual({ status: "finished", outcome: "cancelled" });
    expect(exitCodeForRunState(model.snapshot().run)).toBe(130);
  });

  test("maps lifecycle errors to visible terminal states and exit codes", () => {
    const model = new TuiModel();
    const mutations = model.applyClientResult({ kind: "acceptance-uncertain" });

    expect(model.snapshot().run).toEqual({
      status: "client-error",
      kind: "acceptance-uncertain",
    });
    expect(mutations.at(-1)).toMatchObject({
      type: "append",
      line: { kind: "client-error" },
    });
    expect(exitCodeForRunState(model.snapshot().run)).toBe(2);
    expect(decideQuit(model.snapshot().run, false)).toEqual({ action: "quit", code: 2 });
  });

  test("trims the oldest non-assistant lines when limits are exceeded", () => {
    const model = new TuiModel({ maxLines: 4 });
    // 当前 assistant 行受保护，不应被裁剪。
    model.applyEvent(event("llm.text_delta", { text: "keep" }, 1));
    for (let i = 0; i < 6; i++) {
      model.applyEvent(
        event("tool.started", { toolCallId: `t${i}`, name: "read_file", attempt: 1 }, i + 2),
      );
    }
    const lines = model.snapshot().lines;
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.some((l) => l.kind === "assistant" && l.text === "keep")).toBe(true);
  });
});

describe("formatStatus", () => {
  test("shows terminal outcome", () => {
    const base = {
      connection: "connected" as const,
      sessionId,
      runId,
      run: { status: "finished", outcome: "succeeded" } as const,
      lines: [],
    };
    expect(formatStatus(base)).toContain("succeeded");
    expect(formatStatus(base)).toContain(shortId(runId));
  });

  test("shows running and reconnecting states", () => {
    const base = {
      sessionId,
      runId,
      run: { status: "running" } as const,
      lines: [],
    };
    expect(formatStatus({ ...base, connection: "connected" })).toContain("running");
    expect(formatStatus({ ...base, connection: "disconnected" })).toContain("reconnecting");
  });

  test("shows connecting before run starts", () => {
    const snapshot = {
      connection: "connecting" as const,
      run: { status: "idle" } as const,
      sessionId: undefined,
      runId: undefined,
      lines: [],
    };
    expect(formatStatus(snapshot)).toBe("connecting…");
  });
});

describe("exitCodeForRunState and decideQuit", () => {
  test("maps run outcomes to exit codes", () => {
    expect(exitCodeForRunState({ status: "finished", outcome: "succeeded" })).toBe(0);
    expect(exitCodeForRunState({ status: "finished", outcome: "failed" })).toBe(1);
    expect(exitCodeForRunState({ status: "finished", outcome: "cancelled" })).toBe(130);
    expect(exitCodeForRunState({ status: "running" })).toBe(130);
    expect(exitCodeForRunState({ status: "client-error", kind: "connect-failed" })).toBe(2);
    expect(exitCodeForRunState({ status: "client-error", kind: "internal-error" })).toBe(1);
  });

  test("first quit during running requests cancel, second forces quit", () => {
    expect(decideQuit({ status: "running" }, false)).toEqual({ action: "cancel" });
    expect(decideQuit({ status: "running" }, true)).toEqual({ action: "quit", code: 130 });
    expect(decideQuit({ status: "finished", outcome: "succeeded" }, false)).toEqual({
      action: "quit",
      code: 0,
    });
    expect(decideQuit({ status: "idle" }, false)).toEqual({ action: "quit", code: 130 });
  });
});
