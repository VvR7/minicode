import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import type { AgentEventInput } from "../../src/events/event-bus.ts";
import type { EventJournalStorage } from "../../src/events/event-store.ts";

export const SESSION_A = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
export const SESSION_B = "550e8400-e29b-41d4-a716-446655440001" as SessionId;
export const RUN_A = "6ba7b810-9dad-41d1-80b4-00c04fd430c8" as RunId;
export const RUN_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c9" as RunId;

export function startedInput(
  sessionId: SessionId = SESSION_A,
  runId: RunId = RUN_A,
): AgentEventInput {
  return {
    sessionId,
    runId,
    timestamp: "2026-09-13T08:00:00.000Z",
    durable: true,
    type: "run.started",
    payload: {},
  };
}

export function deltaInput(text: string, runId: RunId = RUN_A): AgentEventInput {
  return {
    sessionId: SESSION_A,
    runId,
    timestamp: "2026-09-13T08:00:01.000Z",
    durable: false,
    type: "llm.text_delta",
    payload: { text },
  };
}

export function finishedInput(runId: RunId = RUN_A): AgentEventInput {
  return {
    sessionId: SESSION_A,
    runId,
    timestamp: "2026-09-13T08:00:02.000Z",
    durable: true,
    type: "run.finished",
    payload: {
      status: "succeeded",
      reason: "completed",
      finalText: "done",
      steps: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

export function sequencedStarted(sequence = 1): AgentEvent {
  return { ...startedInput(), sequence } as AgentEvent;
}

export class MemoryJournalStorage implements EventJournalStorage {
  readonly files = new Map<string, string>();
  appendError: Error | undefined;
  readError: Error | undefined;

  async append(path: string, content: string): Promise<void> {
    if (this.appendError !== undefined) {
      throw this.appendError;
    }
    this.files.set(path, `${this.files.get(path) ?? ""}${content}`);
  }

  async read(path: string): Promise<string | undefined> {
    if (this.readError !== undefined) {
      throw this.readError;
    }
    return this.files.get(path);
  }
}
