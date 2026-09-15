import type { SessionEvent, SessionId, SubscriptionId } from "@minicode/protocol";
import { SessionEventSchema } from "@minicode/protocol";
import type { SessionStore } from "../session/session-store.ts";
import type { SessionStoreFailure } from "../session/types.ts";
import {
  DEFAULT_SUBSCRIPTION_CLOSE_GRACE_MS,
  MAX_SUBSCRIBER_QUEUE_BYTES,
  MAX_SUBSCRIBER_QUEUE_EVENTS,
  type SubscriptionCloseReason,
} from "./event-bus.ts";

type WithoutSequence<Event> = Event extends SessionEvent ? Omit<Event, "sessionSequence"> : never;
export type SessionEventInput = WithoutSequence<SessionEvent>;

export interface SessionEventBusFailure {
  readonly code: "session_store_error" | "invalid_event" | "subscriber_overflow";
  readonly message: string;
  readonly storeFailure?: SessionStoreFailure;
}

export type SessionEventBusResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SessionEventBusFailure };

export type SessionEventHandler = (event: SessionEvent) => Promise<void> | void;

export interface SessionEventSubscription {
  readonly id: SubscriptionId;
  readonly sessionId: SessionId;
  readonly closed: Promise<SubscriptionCloseReason>;
  activate(): void;
  dispose(): void;
}

export interface SessionEventBusOptions {
  readonly maxQueueEvents?: number;
  readonly maxQueueBytes?: number;
  readonly closeGraceMs?: number;
  readonly onPersisted?: (event: SessionEvent) => void;
}

interface SessionState {
  nextSequence: number | undefined;
  tail: Promise<unknown>;
  readonly subscriptions: Set<BufferedSessionSubscription>;
}

interface QueuedSessionEvent {
  readonly event: SessionEvent;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/** 单个 session 订阅的有界暂停队列，保证 replay 与 live 事件原序交付。 */
class BufferedSessionSubscription implements SessionEventSubscription {
  readonly id: SubscriptionId;
  readonly sessionId: SessionId;
  readonly closed: Promise<SubscriptionCloseReason>;
  readonly #handler: SessionEventHandler;
  readonly #onClosed: (subscription: BufferedSessionSubscription) => void;
  readonly #maxQueueEvents: number;
  readonly #maxQueueBytes: number;
  readonly #queue: QueuedSessionEvent[] = [];
  #queueBytes = 0;
  #active: boolean;
  #draining = false;
  #finished = false;
  #resolveClosed: (reason: SubscriptionCloseReason) => void = () => {};

  constructor(
    id: SubscriptionId,
    sessionId: SessionId,
    handler: SessionEventHandler,
    onClosed: (subscription: BufferedSessionSubscription) => void,
    active: boolean,
    options: Required<Pick<SessionEventBusOptions, "maxQueueEvents" | "maxQueueBytes">>,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.#handler = handler;
    this.#onClosed = onClosed;
    this.#active = active;
    this.#maxQueueEvents = options.maxQueueEvents;
    this.#maxQueueBytes = options.maxQueueBytes;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /** 将一条事件加入有界队列；超限时关闭当前慢订阅。 */
  enqueue(event: SessionEvent): boolean {
    if (this.#finished) {
      return false;
    }
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (
      this.#queue.length >= this.#maxQueueEvents ||
      this.#queueBytes + bytes > this.#maxQueueBytes
    ) {
      this.#finish("slow_consumer");
      return false;
    }
    this.#queue.push({ event, bytes });
    this.#queueBytes += bytes;
    this.#scheduleDrain();
    return true;
  }

  /** 在 RPC 响应入队后激活 replay/live 推送。 */
  activate(): void {
    if (this.#finished || this.#active) {
      return;
    }
    this.#active = true;
    this.#scheduleDrain();
  }

  /** 主动释放订阅。 */
  dispose(): void {
    this.#finish("disposed");
  }

  /** 串行消费队列，handler 失败只关闭当前订阅。 */
  async #drain(): Promise<void> {
    try {
      while (this.#active && !this.#finished) {
        const queued = this.#queue.shift();
        if (queued === undefined) {
          break;
        }
        this.#queueBytes -= queued.bytes;
        await this.#handler(queued.event);
      }
    } catch {
      this.#finish("handler_error");
    } finally {
      this.#draining = false;
      if (this.#active && !this.#finished && this.#queue.length > 0) {
        this.#scheduleDrain();
      }
    }
  }

  /** 在可消费且尚未 drain 时调度唯一后台任务。 */
  #scheduleDrain(): void {
    if (!this.#active || this.#finished || this.#draining || this.#queue.length === 0) {
      return;
    }
    this.#draining = true;
    void this.#drain();
  }

  /** 完成 closed Promise 并从所属 session 移除。 */
  #finish(reason: SubscriptionCloseReason): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#queue.length = 0;
    this.#queueBytes = 0;
    this.#onClosed(this);
    this.#resolveClosed(reason);
  }
}

/** 按 session 隔离序列、持久化和订阅的 durable SessionEvent 总线。 */
export class SessionEventBus {
  readonly #store: SessionStore;
  readonly #states = new Map<SessionId, SessionState>();
  readonly #options: Required<
    Pick<SessionEventBusOptions, "maxQueueEvents" | "maxQueueBytes" | "closeGraceMs">
  >;
  readonly #onPersisted: ((event: SessionEvent) => void) | undefined;

  constructor(store: SessionStore, options: SessionEventBusOptions = {}) {
    this.#store = store;
    this.#options = {
      maxQueueEvents: options.maxQueueEvents ?? MAX_SUBSCRIBER_QUEUE_EVENTS,
      maxQueueBytes: options.maxQueueBytes ?? MAX_SUBSCRIBER_QUEUE_BYTES,
      closeGraceMs: options.closeGraceMs ?? DEFAULT_SUBSCRIPTION_CLOSE_GRACE_MS,
    };
    this.#onPersisted = options.onPersisted;
  }

  /** 持久化一条 session event 后按订阅顺序广播。 */
  publish(input: SessionEventInput): Promise<SessionEventBusResult<SessionEvent>> {
    const state = this.#stateFor(input.sessionId);
    return this.#withLock(state, async () => {
      const initialized = await this.#initialize(input.sessionId, state);
      if (!initialized.ok) {
        return initialized;
      }
      const parsed = SessionEventSchema.safeParse({
        ...input,
        sessionSequence: state.nextSequence,
      });
      if (!parsed.success || !parsed.data.durable) {
        return { ok: false, error: { code: "invalid_event", message: "session event is invalid" } };
      }
      const persisted = await this.#store.appendSessionEvent(input.sessionId, parsed.data);
      if (!persisted.ok) {
        return this.#storeFailure(persisted.error);
      }
      state.nextSequence = parsed.data.sessionSequence + 1;
      try {
        this.#onPersisted?.(parsed.data);
      } catch {
        // Trace/observer 永远不能改变 session event 的持久化结果。
      }
      for (const subscription of [...state.subscriptions]) {
        subscription.enqueue(parsed.data);
      }
      return { ok: true, value: parsed.data };
    });
  }

  /** 原子建立 cursor replay + live 订阅，可选择保持暂停直到响应入队。 */
  subscribe(
    sessionId: SessionId,
    handler: SessionEventHandler,
    afterSequence = 0,
    subscriptionId: SubscriptionId = crypto.randomUUID(),
    startPaused = false,
  ): Promise<
    SessionEventBusResult<{ subscription: SessionEventSubscription; latestSequence: number }>
  > {
    const state = this.#stateFor(sessionId);
    return this.#withLock(state, async () => {
      const initialized = await this.#initialize(sessionId, state);
      if (!initialized.ok) {
        return initialized;
      }
      const replay = await this.#store.readSessionEvents(sessionId, afterSequence);
      if (!replay.ok) {
        return this.#storeFailure(replay.error);
      }
      const subscription = new BufferedSessionSubscription(
        subscriptionId,
        sessionId,
        handler,
        (closed) => state.subscriptions.delete(closed),
        !startPaused,
        this.#options,
      );
      for (const event of replay.value) {
        if (!subscription.enqueue(event)) {
          return {
            ok: false,
            error: { code: "subscriber_overflow", message: "session replay exceeds queue limits" },
          };
        }
      }
      state.subscriptions.add(subscription);
      return {
        ok: true,
        value: { subscription, latestSequence: (state.nextSequence ?? 1) - 1 },
      };
    });
  }

  /** 返回指定 session 当前 live 订阅数。 */
  subscriptionCount(sessionId: SessionId): number {
    return this.#states.get(sessionId)?.subscriptions.size ?? 0;
  }

  /** 读取或创建 session 内存状态。 */
  #stateFor(sessionId: SessionId): SessionState {
    const existing = this.#states.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const state: SessionState = {
      nextSequence: undefined,
      tail: Promise.resolve(),
      subscriptions: new Set(),
    };
    this.#states.set(sessionId, state);
    return state;
  }

  /** 首次访问时从权威 journal 恢复下一序号。 */
  async #initialize(
    sessionId: SessionId,
    state: SessionState,
  ): Promise<SessionEventBusResult<void>> {
    if (state.nextSequence !== undefined) {
      return { ok: true, value: undefined };
    }
    const loaded = await this.#store.load(sessionId);
    if (!loaded.ok) {
      return this.#storeFailure(loaded.error);
    }
    state.nextSequence = loaded.value.latestSessionSequence + 1;
    return { ok: true, value: undefined };
  }

  /** 串行化同一 session 的 publish/subscribe 临界区。 */
  #withLock<Value>(state: SessionState, operation: () => Promise<Value>): Promise<Value> {
    const result = state.tail.then(operation, operation);
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 将 SessionStore 错误收敛为总线错误。 */
  #storeFailure(failure: SessionStoreFailure): SessionEventBusResult<never> {
    return {
      ok: false,
      error: { code: "session_store_error", message: failure.message, storeFailure: failure },
    };
  }
}
