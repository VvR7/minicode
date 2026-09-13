import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import { EventBus } from "../../src/events/event-bus.ts";
import type { EventJournalStorage } from "../../src/events/event-store.ts";
import type { EventSubscription } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { LlmError } from "../../src/llm/errors.ts";
import type { LlmProvider, LlmStreamOptions } from "../../src/llm/provider.ts";
import type { LlmMessage, LlmResponse, LlmStreamEvent, LlmToolCall } from "../../src/llm/types.ts";

export const SESSION_A = "550e8400-e29b-41d4-a716-446655440010" as SessionId;
export const SESSION_B = "550e8400-e29b-41d4-a716-446655440011" as SessionId;
export const RUN_A = "6ba7b810-9dad-41d1-80b4-00c04fd43010" as RunId;
export const RUN_B = "6ba7b810-9dad-41d1-80b4-00c04fd43011" as RunId;

export const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
} as const;

export function usage(overrides: Partial<LlmResponse["usage"]> = {}): LlmResponse["usage"] {
  return { ...EMPTY_USAGE, ...overrides };
}

export function textResponse(text: string, overrides: Partial<LlmResponse> = {}): LlmResponse {
  return { text, toolCalls: [], usage: usage(), finishReason: "end_turn", ...overrides };
}

export function toolResponse(toolCalls: LlmToolCall[]): LlmResponse {
  return { text: "", toolCalls, usage: usage(), finishReason: "tool_use" };
}

export function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): LlmToolCall {
  return { id, name, input };
}

/** 内存 journal，避免测试依赖文件系统。 */
export class MemoryJournalStorage implements EventJournalStorage {
  readonly files = new Map<string, string>();

  async append(path: string, content: string): Promise<void> {
    this.files.set(path, `${this.files.get(path) ?? ""}${content}`);
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
}

export function createBus(): EventBus {
  return new EventBus(new EventStore("/unused", new MemoryJournalStorage()));
}

/** 单次 stream 调用的可编程脚本。 */
export interface FakeTurn {
  /** 文本增量，逐段作为 text_delta 发布。 */
  readonly deltas?: readonly string[];
  /** completed 事件携带的归一化响应。 */
  readonly response?: LlmResponse;
  /** 若指定，在 yield 任何事件前抛出该错误。 */
  readonly error?: LlmError;
}

/**
 * 按脚本依次返回响应的 provider。每次 stream 调用消费一个 turn，
 * 并记录收到的 messages 与 options 供断言。
 */
export class FakeProvider implements LlmProvider {
  readonly providerName = "fake";
  readonly model = "fake-model";
  readonly turns: FakeTurn[];
  readonly calls: { messages: readonly LlmMessage[]; options: LlmStreamOptions | undefined }[] = [];

  constructor(turns: readonly FakeTurn[]) {
    this.turns = [...turns];
  }

  async *stream(
    messages: readonly LlmMessage[],
    options?: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    this.calls.push({ messages: [...messages], options });
    if (options?.signal?.aborted === true) {
      throw new LlmError("aborted", "aborted before stream started");
    }
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new LlmError("invalid_response", "no more turns");
    }
    if (turn.error !== undefined) {
      throw turn.error;
    }
    for (const delta of turn.deltas ?? []) {
      yield { type: "text_delta", text: delta };
    }
    if (turn.response === undefined) {
      throw new LlmError("invalid_response", "turn missing response");
    }
    yield { type: "completed", response: turn.response };
  }
}

/** 订阅并收集事件；返回 subscription 以便 await closed 等待 drain 完成。 */
export async function collectEvents(
  bus: EventBus,
  sessionId: SessionId,
  runId: RunId,
): Promise<{ events: AgentEvent[]; subscription: EventSubscription }> {
  const events: AgentEvent[] = [];
  const result = await bus.subscribe(sessionId, runId, (event) => {
    events.push(event);
  });
  if (!result.ok) {
    throw new Error(`subscribe failed: ${result.error.code}`);
  }
  return { events, subscription: result.value };
}
