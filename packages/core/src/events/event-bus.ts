import type { AgentEvent, RunId, SessionId, SubscriptionId } from "@minicode/protocol";
import { AgentEventSchema } from "@minicode/protocol";
import type { EventStore, EventStoreFailure } from "./event-store.ts";

export const MAX_SUBSCRIBER_QUEUE_EVENTS = 256;
export const MAX_SUBSCRIBER_QUEUE_BYTES = 4 * 1024 * 1024;

type WithoutSequence<Event> = Event extends AgentEvent ? Omit<Event, "sequence"> : never;
export type AgentEventInput = WithoutSequence<AgentEvent>;

export interface EventBusFailure {
  readonly code: "invalid_event" | "event_store_error" | "run_finished" | "subscriber_overflow";
  readonly message: string;
  readonly storeFailure?: EventStoreFailure;
}

export type EventBusResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: EventBusFailure };

export type AgentEventHandler = (event: AgentEvent) => Promise<void> | void;

export interface EventSubscription {
  readonly id: SubscriptionId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly closed: Promise<void>;
  activate(): void;
  dispose(): void;
}

interface QueuedEvent {
  readonly event: AgentEvent;
  readonly bytes: number;
}

interface RunState {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  nextSequence: number | undefined;
  finished: boolean | undefined;
  tail: Promise<void>;
  readonly subscriptions: Set<BufferedEventSubscription>;
}

const encoder = new TextEncoder();

class BufferedEventSubscription implements EventSubscription {
  readonly id: SubscriptionId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly closed: Promise<void>;
  readonly #handler: AgentEventHandler;
  readonly #onClosed: (subscription: BufferedEventSubscription) => void;
  readonly #queue: QueuedEvent[] = [];
  #queuedBytes = 0;
  #active: boolean;
  #accepting = true;
  #draining = false;
  #closedState = false;
  #resolveClosed = (): void => {};

  constructor(
    id: SubscriptionId,
    sessionId: SessionId,
    runId: RunId,
    handler: AgentEventHandler,
    onClosed: (subscription: BufferedEventSubscription) => void,
    active: boolean,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.runId = runId;
    this.#handler = handler;
    this.#onClosed = onClosed;
    this.#active = active;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  enqueue(event: AgentEvent): boolean {
    if (!this.#accepting) {
      return false;
    }
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (
      this.#queue.length >= MAX_SUBSCRIBER_QUEUE_EVENTS ||
      this.#queuedBytes + bytes > MAX_SUBSCRIBER_QUEUE_BYTES
    ) {
      this.dispose();
      return false;
    }
    this.#queue.push({ event, bytes });
    this.#queuedBytes += bytes;
    this.#scheduleDrain();
    return true;
  }

  activate(): void {
    if (this.#active || this.#closedState) {
      return;
    }
    this.#active = true;
    this.#scheduleDrain();
    if (!this.#accepting && this.#queue.length === 0) {
      this.#finish();
    }
  }

  /** run 结束时不再接受新事件，但允许已经排队的终态事件发送完毕。 */
  complete(): void {
    if (!this.#accepting) {
      return;
    }
    this.#accepting = false;
    this.#onClosed(this);
    if (!this.#draining && this.#queue.length === 0) {
      this.#finish();
    }
  }

  dispose(): void {
    if (!this.#accepting && this.#closedState) {
      return;
    }
    this.#accepting = false;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#onClosed(this);
    this.#finish();
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0 && !this.#closedState) {
      const queued = this.#queue.shift();
      if (queued === undefined) {
        break;
      }
      this.#queuedBytes -= queued.bytes;
      try {
        await this.#handler(queued.event);
      } catch {
        // handler 故障只关闭自己的订阅，不能反向传播到 publish 或其他 run。
        this.dispose();
        return;
      }
    }
    this.#draining = false;
    if (!this.#accepting) {
      this.#finish();
    }
  }

  #scheduleDrain(): void {
    if (!this.#active || this.#draining || this.#queue.length === 0) {
      return;
    }
    this.#draining = true;
    queueMicrotask(() => void this.#drain());
  }

  #finish(): void {
    if (this.#closedState) {
      return;
    }
    this.#closedState = true;
    this.#resolveClosed();
  }
}

/** 为每个 session/run 分配独立序列、持久化链和订阅集合。 */
export class EventBus {
  readonly #store: EventStore;
  readonly #runs = new Map<string, RunState>();

  constructor(store: EventStore) {
    this.#store = store;
  }

  publish(input: AgentEventInput): Promise<EventBusResult<AgentEvent>> {
    const state = this.#stateFor(input.sessionId, input.runId);
    return this.#withRunLock(state, async () => {
      const initialized = await this.#initializeSequence(state);
      if (!initialized.ok) {
        return initialized;
      }
      if (state.finished) {
        return {
          ok: false,
          error: { code: "run_finished", message: "cannot publish after run completion" },
        };
      }
      const parsed = AgentEventSchema.safeParse({ ...input, sequence: state.nextSequence });
      if (!parsed.success || (parsed.data.type === "run.finished" && !parsed.data.durable)) {
        return {
          ok: false,
          error: { code: "invalid_event", message: "agent event is invalid" },
        };
      }
      const event = parsed.data;
      if (event.durable) {
        const persisted = await this.#store.append(event);
        if (!persisted.ok) {
          return this.#storeFailure(persisted.error);
        }
      }

      state.nextSequence = event.sequence + 1;
      for (const subscription of [...state.subscriptions]) {
        subscription.enqueue(event);
      }
      if (event.type === "run.finished") {
        state.finished = true;
        for (const subscription of [...state.subscriptions]) {
          subscription.complete();
        }
        state.subscriptions.clear();
      }
      return { ok: true, value: event };
    });
  }

  subscribe(
    sessionId: SessionId,
    runId: RunId,
    handler: AgentEventHandler,
    afterSequence = 0,
    subscriptionId: SubscriptionId = crypto.randomUUID(),
    startPaused = false,
  ): Promise<EventBusResult<EventSubscription>> {
    const state = this.#stateFor(sessionId, runId);
    return this.#withRunLock(state, async () => {
      const initialized = await this.#initializeSequence(state);
      if (!initialized.ok) {
        return initialized;
      }
      const replay = await this.#store.read(sessionId, runId, afterSequence);
      if (!replay.ok) {
        return this.#storeFailure(replay.error);
      }

      const subscription = new BufferedEventSubscription(
        subscriptionId,
        sessionId,
        runId,
        handler,
        (closed) => state.subscriptions.delete(closed),
        !startPaused,
      );
      for (const event of replay.value) {
        if (!subscription.enqueue(event)) {
          return {
            ok: false,
            error: { code: "subscriber_overflow", message: "event replay exceeds queue limits" },
          };
        }
      }

      if (state.finished) {
        subscription.complete();
      } else {
        // 仍持有 run lock 时先接入 live 集合，publish 无法插入 replay 与 live 之间。
        state.subscriptions.add(subscription);
      }
      return { ok: true, value: subscription };
    });
  }

  subscriptionCount(sessionId: SessionId, runId: RunId): number {
    return this.#runs.get(this.#runKey(sessionId, runId))?.subscriptions.size ?? 0;
  }

  #stateFor(sessionId: SessionId, runId: RunId): RunState {
    const key = this.#runKey(sessionId, runId);
    const existing = this.#runs.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const state: RunState = {
      sessionId,
      runId,
      nextSequence: undefined,
      finished: undefined,
      tail: Promise.resolve(),
      subscriptions: new Set(),
    };
    this.#runs.set(key, state);
    return state;
  }

  #runKey(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }

  #withRunLock<Value>(state: RunState, operation: () => Promise<Value>): Promise<Value> {
    const result = state.tail.then(operation);
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #initializeSequence(state: RunState): Promise<EventBusResult<void>> {
    if (state.nextSequence !== undefined) {
      return { ok: true, value: undefined };
    }
    const existing = await this.#store.read(state.sessionId, state.runId);
    if (!existing.ok) {
      return this.#storeFailure(existing.error);
    }
    state.nextSequence = (existing.value.at(-1)?.sequence ?? 0) + 1;
    state.finished = existing.value.some((event) => event.type === "run.finished");
    return { ok: true, value: undefined };
  }

  #storeFailure(failure: EventStoreFailure): EventBusResult<never> {
    return {
      ok: false,
      error: {
        code: "event_store_error",
        message: failure.message,
        storeFailure: failure,
      },
    };
  }
}
