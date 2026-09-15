import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  CoreEndpoint,
  HistoryTurn,
  JsonRpcNotificationEnvelope,
  SessionEvent,
  SessionId,
} from "@minicode/protocol";
import { type NdjsonRpcConnection, RpcClientError } from "../src/ndjson-rpc-client.ts";
import { SessionController, type SessionControllerEvent } from "../src/session-controller.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const turnId = "650e8400-e29b-41d4-a716-446655440000";
const runId = "750e8400-e29b-41d4-a716-446655440000";
const clientMessageId = "850e8400-e29b-41d4-a716-446655440000";
const sessionSubscriptionId = "950e8400-e29b-41d4-a716-446655440000";
const runSubscriptionId = "a50e8400-e29b-41d4-a716-446655440000";
const endpoint: CoreEndpoint = { host: "127.0.0.1", port: 7437 };
const now = "2026-09-15T08:00:00.000Z";

const summary = {
  sessionId,
  mode: "chat" as const,
  status: "running" as const,
  title: "hello",
  workspaceRoot: "/workspace",
  createdAt: now,
  updatedAt: now,
  latestSessionSequence: 1,
  activeRun: { turnId, runId },
};

const runningTurn: HistoryTurn = {
  turnId,
  runId,
  clientMessageId,
  status: "running",
  acceptedAt: now,
  includedInContext: false,
  messages: [
    {
      messageId: "user-1",
      turnId,
      runId,
      role: "user",
      timestamp: now,
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

type RequestHandler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  connection: FakeConnection,
) => unknown | Promise<unknown>;

/** 可编程长连接，测试通过请求钩子精确控制 replay、断线和重连时点。 */
class FakeConnection {
  #listeners = new Set<(notification: JsonRpcNotificationEnvelope) => void>();
  #closedSignal = Promise.withResolvers<void>();
  readonly requests: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  readonly handler: RequestHandler;
  closed = false;

  /** 当前 listener 数，用于验证 dispose 清理。 */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  constructor(handler: RequestHandler) {
    this.handler = handler;
  }

  /** 模拟泛型 RPC request，并保留请求参数供断言。 */
  async request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handler(method, params, this);
  }

  /** 注册 notification listener。 */
  onNotification(listener: (notification: JsonRpcNotificationEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 等待连接关闭。 */
  waitUntilClosed(): Promise<void> {
    return this.#closedSignal.promise;
  }

  /** 幂等关闭连接。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#closedSignal.resolve();
  }

  /** 向当前连接同步推送一条通知。 */
  emit(notification: JsonRpcNotificationEnvelope): void {
    for (const listener of this.#listeners) listener(notification);
  }
}

/** 构造 session 或 run 的 event.push。 */
function push(
  subscriptionId: string,
  event: SessionEvent | AgentEvent,
): JsonRpcNotificationEnvelope {
  return { jsonrpc: "2.0", method: "event.push", params: { subscriptionId, event } };
}

/** 构造权威 session event。 */
function sessionEvent(
  type: SessionEvent["type"],
  sequence: number,
  payload: SessionEvent["payload"],
): SessionEvent {
  return {
    sessionId,
    sessionSequence: sequence,
    timestamp: now,
    durable: true,
    type,
    payload,
  } as SessionEvent;
}

/** 构造 durable run event。 */
function runEvent(
  type: AgentEvent["type"],
  sequence: number,
  payload: AgentEvent["payload"],
): AgentEvent {
  return { sessionId, runId, sequence, timestamp: now, durable: true, type, payload } as AgentEvent;
}

/** 标准 attach RPC 响应，可按测试需要替换 history。 */
function attachHandler(
  historyTurns: readonly HistoryTurn[],
  onRunSubscribe?: (connection: FakeConnection) => void,
): RequestHandler {
  return (method, _params, connection) => {
    if (method === "session.getHistory") {
      return { result: { session: summary, turns: historyTurns, throughSessionSequence: 1 } };
    }
    if (method === "session.subscribe") {
      return {
        result: {
          subscriptionId: sessionSubscriptionId,
          sessionId,
          latestSequence: 1,
          activeRun: { turnId, runId },
        },
      };
    }
    if (method === "event.subscribe") {
      onRunSubscribe?.(connection);
      return { result: { subscriptionId: runSubscriptionId, sessionId, runId } };
    }
    if (method === "event.unsubscribe") return { result: { removed: true } };
    if (method === "agent.cancel") return { result: { outcome: "cancellation_requested" } };
    throw new Error(`unexpected method: ${method}`);
  };
}

/** 把 fake 转为生产连接类型，避免测试复制 transport 实现。 */
function asConnection(connection: FakeConnection): NdjsonRpcConnection {
  return connection as unknown as NdjsonRpcConnection;
}

describe("SessionController", () => {
  test("emits history before the complete run replay and deduplicates replayed events", async () => {
    const connection = new FakeConnection(
      attachHandler([runningTurn], (current) => {
        current.emit(push(runSubscriptionId, runEvent("llm.text_delta", 1, { text: "Hel" })));
        current.emit(push(runSubscriptionId, runEvent("llm.text_delta", 1, { text: "Hel" })));
        current.emit(push(runSubscriptionId, runEvent("llm.text_delta", 2, { text: "lo" })));
      }),
    );
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      endpoint,
      connect: () => Promise.resolve(asConnection(connection)),
      onEvent: (event) => {
        events.push(event);
      },
    });

    await controller.attach(sessionId);

    expect(events.map((event) => event.type)).toEqual([
      "controller.status",
      "session.attached",
      "turn.snapshot",
      "run.event",
      "run.event",
      "controller.status",
    ]);
    expect(
      events
        .filter(
          (event): event is Extract<SessionControllerEvent, { type: "run.event" }> =>
            event.type === "run.event",
        )
        .map((event) => event.event.payload),
    ).toEqual([{ text: "Hel" }, { text: "lo" }]);
    await controller.dispose();
  });

  test("observes another client's accepted run and emits one accepted and one terminal transition", async () => {
    const idleSummary = { ...summary, status: "idle" as const, activeRun: undefined };
    const connection = new FakeConnection((method) => {
      if (method === "session.getHistory") {
        return { result: { session: idleSummary, turns: [], throughSessionSequence: 0 } };
      }
      if (method === "session.subscribe") {
        return {
          result: { subscriptionId: sessionSubscriptionId, sessionId, latestSequence: 0 },
        };
      }
      if (method === "event.subscribe") {
        return { result: { subscriptionId: runSubscriptionId, sessionId, runId } };
      }
      if (method === "event.unsubscribe") return { result: { removed: true } };
      throw new Error(`unexpected method: ${method}`);
    });
    const events: SessionControllerEvent[] = [];
    const committed = Promise.withResolvers<void>();
    const controller = new SessionController({
      endpoint,
      connect: () => Promise.resolve(asConnection(connection)),
      onEvent: (event) => {
        events.push(event);
        if (event.type === "turn.committed") committed.resolve();
      },
    });
    await controller.attach(sessionId);

    const accepted = sessionEvent("session.turn_accepted", 1, {
      turnId,
      runId,
      clientMessageId,
      userMessage: "from other TUI",
    });
    connection.emit(push(sessionSubscriptionId, accepted));
    connection.emit(push(sessionSubscriptionId, accepted));
    connection.emit(push(runSubscriptionId, runEvent("run.started", 1, {})));
    // 两条订阅跨流到达次序不稳定：先到的 session 终态必须等待 run 详细终态。
    connection.emit(
      push(
        sessionSubscriptionId,
        sessionEvent("session.turn_finished", 2, {
          turnId,
          runId,
          status: "succeeded",
          reason: "completed",
        }),
      ),
    );
    connection.emit(
      push(
        runSubscriptionId,
        runEvent("run.finished", 2, {
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
        }),
      ),
    );
    await committed.promise;

    expect(events.filter((event) => event.type === "turn.accepted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.event")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.committed")).toHaveLength(1);
    expect(
      events.findIndex(
        (event) => event.type === "run.event" && event.event.type === "run.finished",
      ),
    ).toBeLessThan(events.findIndex((event) => event.type === "turn.committed"));
    expect(connection.requests.some((request) => request.method === "event.subscribe")).toBe(true);
    await controller.dispose();
    expect(connection.listenerCount).toBe(0);
  });

  test("fills an accept-and-finish race between getHistory and session.subscribe", async () => {
    const idleSummary = { ...summary, status: "idle" as const, activeRun: undefined };
    const accepted = sessionEvent("session.turn_accepted", 1, {
      turnId,
      runId,
      clientMessageId,
      userMessage: "racing question",
    });
    const finished = sessionEvent("session.turn_finished", 2, {
      turnId,
      runId,
      status: "succeeded",
      reason: "completed",
    });
    const connection = new FakeConnection((method, _params, current) => {
      if (method === "session.getHistory") {
        return { result: { session: idleSummary, turns: [], throughSessionSequence: 0 } };
      }
      if (method === "session.subscribe") {
        current.emit(push(sessionSubscriptionId, accepted));
        current.emit(push(sessionSubscriptionId, finished));
        return {
          result: { subscriptionId: sessionSubscriptionId, sessionId, latestSequence: 2 },
        };
      }
      if (method === "event.subscribe") {
        current.emit(push(runSubscriptionId, runEvent("llm.text_delta", 1, { text: "done" })));
        current.emit(
          push(
            runSubscriptionId,
            runEvent("run.finished", 2, {
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
            }),
          ),
        );
        return { result: { subscriptionId: runSubscriptionId, sessionId, runId } };
      }
      if (method === "event.unsubscribe") return { result: { removed: true } };
      throw new Error(`unexpected method: ${method}`);
    });
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      endpoint,
      connect: () => Promise.resolve(asConnection(connection)),
      onEvent: (event) => {
        events.push(event);
      },
    });

    await controller.attach(sessionId);

    const timeline = events.map((event) =>
      event.type === "run.event" ? `${event.type}:${event.event.type}` : event.type,
    );
    expect(timeline).toEqual([
      "controller.status",
      "session.attached",
      "turn.accepted",
      "run.event:llm.text_delta",
      "run.event:run.finished",
      "turn.committed",
      "controller.status",
    ]);
    await controller.dispose();
  });

  test("does not advance a run cursor until the consumer succeeds", async () => {
    const first = new FakeConnection(attachHandler([runningTurn]));
    const replayed = Promise.withResolvers<void>();
    const second = new FakeConnection(
      attachHandler([runningTurn], (connection) => {
        connection.emit(push(runSubscriptionId, runEvent("llm.text_delta", 1, { text: "retry" })));
      }),
    );
    const connections = [first, second];
    let failOnce = true;
    const controller = new SessionController({
      endpoint,
      reconnectDelayMs: 0,
      connect: () => {
        const connection = connections.shift();
        if (connection === undefined) throw new Error("unexpected connection");
        return Promise.resolve(asConnection(connection));
      },
      onEvent: (event) => {
        if (event.type !== "run.event") return;
        if (failOnce) {
          failOnce = false;
          throw new Error("renderer rejected event");
        }
        replayed.resolve();
      },
    });
    await controller.attach(sessionId);

    first.emit(push(runSubscriptionId, runEvent("llm.text_delta", 1, { text: "retry" })));
    await replayed.promise;

    const subscribe = second.requests.find((request) => request.method === "event.subscribe");
    expect(
      subscribe === undefined ? undefined : Reflect.get(subscribe.params, "afterSequence"),
    ).toBe(0);
    await controller.dispose();
  });

  test("retries an acceptance-uncertain send with the same clientMessageId and content", async () => {
    let sentParams: Readonly<Record<string, unknown>> | undefined;
    const first = new FakeConnection(async (method, params, connection) => {
      const base = attachHandler([runningTurn]);
      if (method !== "session.sendMessage") return base(method, params, connection);
      sentParams = params;
      connection.close();
      throw new Error("response lost");
    });
    const second = new FakeConnection(async (method, params, connection) => {
      const base = attachHandler([runningTurn]);
      if (method !== "session.sendMessage") return base(method, params, connection);
      if (sentParams === undefined) throw new Error("first send was not recorded");
      expect(params).toEqual(sentParams);
      return { result: { status: "accepted", sessionId, turnId, runId } };
    });
    const connections = [first, second];
    const controller = new SessionController({
      endpoint,
      reconnectDelayMs: 0,
      connect: () => {
        const connection = connections.shift();
        if (connection === undefined) throw new Error("unexpected connection");
        return Promise.resolve(asConnection(connection));
      },
      onEvent: () => {},
    });
    await controller.attach(sessionId);

    const result = await controller.sendMessage("same content");

    expect(result).toEqual({ status: "accepted", sessionId, turnId, runId });
    expect(sentParams === undefined ? undefined : Reflect.get(sentParams, "content")).toBe(
      "same content",
    );
    expect(
      typeof (sentParams === undefined ? undefined : Reflect.get(sentParams, "clientMessageId")),
    ).toBe("string");
    await controller.dispose();
  });

  test("surfaces session_busy without retrying or emitting an optimistic user turn", async () => {
    const connection = new FakeConnection(async (method, params, current) => {
      const base = attachHandler([runningTurn]);
      if (method !== "session.sendMessage") return base(method, params, current);
      throw new RpcClientError("core error -32011: session is busy", {
        code: -32011,
        data: { sessionId, turnId, runId },
      });
    });
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      endpoint,
      connect: () => Promise.resolve(asConnection(connection)),
      onEvent: (event) => {
        events.push(event);
      },
    });
    await controller.attach(sessionId);

    await expect(controller.sendMessage("losing draft")).rejects.toMatchObject({ code: -32011 });
    expect(
      connection.requests.filter((request) => request.method === "session.sendMessage"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.accepted")).toHaveLength(0);
    await controller.dispose();
  });

  test("cancels only the active session and run identity", async () => {
    const connection = new FakeConnection(attachHandler([runningTurn]));
    const controller = new SessionController({
      endpoint,
      connect: () => Promise.resolve(asConnection(connection)),
      onEvent: () => {},
    });
    await controller.attach(sessionId);

    expect(await controller.cancelActiveRun()).toEqual({ outcome: "cancellation_requested" });
    expect(
      connection.requests.find((request) => request.method === "agent.cancel")?.params,
    ).toEqual({ sessionId, runId });
    await controller.dispose();
  });
});
