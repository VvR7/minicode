import { describe, expect, test } from "bun:test";

import type { AgentEvent, CoreEndpoint, JsonRpcNotificationEnvelope } from "@minicode/protocol";
import {
  AgentRunClient,
  type AgentRunClientCallbacks,
  type AgentRunClientResult,
} from "../src/agent-run-client.ts";
import { type NdjsonRpcConnection, RpcClientError } from "../src/ndjson-rpc-client.ts";
import {
  permissionRequest,
  permissionResolved,
  runFinished,
} from "./helpers/permission-fixture.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const subscriptionId = "750e8400-e29b-41d4-a716-446655440001";

const endpoint: CoreEndpoint = { host: "127.0.0.1", port: 7437 };

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

function pushNotification(
  subscription: string,
  evt: AgentEvent,
  extra: { readonly sessionId?: string; readonly runId?: string } = {},
): JsonRpcNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "event.push",
    params: {
      subscriptionId: subscription,
      event: {
        ...evt,
        sessionId: extra.sessionId ?? evt.sessionId,
        runId: extra.runId ?? evt.runId,
      },
    },
  };
}

type RequestHandler = (method: string, params: Record<string, unknown>) => unknown;

/** 可编程的 fake 连接：记录 listener，支持手动推送事件与主动断开。 */
class FakeConnection {
  #listeners = new Set<(notification: JsonRpcNotificationEnvelope) => void>();
  #closed = Promise.withResolvers<void>();
  #accepted = Promise.withResolvers<void>();
  #listening = Promise.withResolvers<void>();
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  requestHandler: RequestHandler = () => {
    throw new Error("unexpected request");
  };
  closed = false;

  get accepted(): Promise<void> {
    return this.#accepted.promise;
  }

  /** drain 已注册事件 listener 后 resolve，供测试在推送事件前等待。 */
  get listening(): Promise<void> {
    return this.#listening.promise;
  }

  /** 当前 notification listener 数，用于验证 shutdown 清理。 */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "agent.run") {
      this.#accepted.resolve();
    }
    return Promise.resolve(this.requestHandler(method, params));
  }

  onNotification(listener: (notification: JsonRpcNotificationEnvelope) => void): () => void {
    this.#listeners.add(listener);
    this.#listening.resolve();
    return () => this.#listeners.delete(listener);
  }

  waitUntilClosed(): Promise<void> {
    return this.#closed.promise;
  }

  close(): void {
    this.closed = true;
    this.#closed.resolve();
  }

  emit(notification: JsonRpcNotificationEnvelope): void {
    for (const listener of this.#listeners) {
      listener(notification);
    }
  }
}

/** 把 FakeConnection 伪装成 NdjsonRpcConnection，并记录连接顺序。 */
function connectSequence(connections: FakeConnection[]) {
  let index = 0;
  return {
    connect: async (): Promise<NdjsonRpcConnection> => {
      const connection = connections[index];
      if (connection === undefined) {
        throw new Error("no more connections");
      }
      index += 1;
      return connection as unknown as NdjsonRpcConnection;
    },
    count: () => index,
  };
}

/** 标准 identity 与各方法响应。 */
const identity = {
  status: "accepted",
  sessionId,
  runId,
  subscriptionId,
};

function defaultHandler(method: string, _params: Record<string, unknown>): unknown {
  if (method === "agent.run") {
    return { result: identity };
  }
  if (method === "event.subscribe") {
    return { result: { subscriptionId, sessionId, runId } };
  }
  if (method === "agent.cancel") {
    return { result: { outcome: "cancellation_requested" } };
  }
  throw new Error(`unexpected method: ${method}`);
}

function collectCallbacks() {
  const events: AgentEvent[] = [];
  const statuses: string[] = [];
  const callbacks: AgentRunClientCallbacks = {
    onEvent: (evt) => events.push(evt),
    onStatus: (status) => statuses.push(status.state),
  };
  return { events, statuses, callbacks };
}

describe("AgentRunClient", () => {
  for (const outcome of ["accepted", "already_resolved", "not_found"] as const) {
    test(`permission response ${outcome} respects Core authority`, async () => {
      const connection = new FakeConnection();
      connection.requestHandler = (method, params) =>
        method === "permission.respond" ? { result: { outcome } } : defaultHandler(method, params);
      const client = new AgentRunClient();
      await expect(
        client.respondPermission(permissionRequest.payload.permissionRequestId, "allow_once"),
      ).rejects.toThrow("not connected");
      const { callbacks, events } = collectCallbacks();
      const snapshots: string[][] = [];
      callbacks.onPermissions = (entries) => snapshots.push(entries.map((entry) => entry.status));
      const running = client.run(
        {
          goal: "x",
          workspaceRoot: "/w",
          endpoint,
          connect: async () => connection as unknown as NdjsonRpcConnection,
        },
        callbacks,
      );
      await connection.listening;
      connection.emit(pushNotification(subscriptionId, permissionRequest));
      connection.emit(pushNotification(subscriptionId, permissionRequest));
      expect(client.permissions).toHaveLength(1);
      expect(
        await client.respondPermission(
          permissionRequest.payload.permissionRequestId,
          "always_deny",
        ),
      ).toEqual({ outcome });
      expect(connection.requests.at(-1)).toEqual({
        method: "permission.respond",
        params: {
          sessionId,
          runId,
          permissionRequestId: permissionRequest.payload.permissionRequestId,
          decision: "always_deny",
        },
      });
      expect(client.permissions[0]?.status).toBe(outcome === "accepted" ? "pending" : "closed");
      connection.emit(
        pushNotification(subscriptionId, permissionResolved(permissionRequest, "deny_once")),
      );
      expect(client.permissions[0]?.status).toBe("resolved");
      connection.emit(pushNotification(subscriptionId, runFinished()));
      expect((await running).kind).toBe("finished");
      expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
      expect(snapshots).toContainEqual(["resolved"]);
    });
  }

  test("failed approval send reconnects and retains pending state without duplicating replay", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    first.requestHandler = (method, params) => {
      if (method === "permission.respond") throw new Error("lost response");
      return defaultHandler(method, params);
    };
    second.requestHandler = (method, params) =>
      method === "permission.respond"
        ? { result: { outcome: "accepted" } }
        : defaultHandler(method, params);
    const client = new AgentRunClient();
    const { callbacks, events } = collectCallbacks();
    const snapshots: string[][] = [];
    callbacks.onPermissions = (entries) => snapshots.push(entries.map((entry) => entry.status));
    const { connect } = connectSequence([first, second]);
    const running = client.run(
      { goal: "x", workspaceRoot: "/w", endpoint, connect, reconnectDelayMs: 0 },
      callbacks,
    );
    await first.listening;
    first.emit(pushNotification(subscriptionId, permissionRequest));
    await expect(
      client.respondPermission(permissionRequest.payload.permissionRequestId, "allow_once"),
    ).rejects.toThrow("lost response");
    await second.listening;
    second.emit(pushNotification(subscriptionId, permissionRequest));
    expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    expect(snapshots.filter((snapshot) => snapshot[0] === "pending")).toHaveLength(2);
    expect(second.requests[0]?.params).toMatchObject({ afterSequence: 1 });
    expect(
      await client.respondPermission(permissionRequest.payload.permissionRequestId, "allow_once"),
    ).toEqual({ outcome: "accepted" });
    second.emit(pushNotification(subscriptionId, runFinished()));
    await running;
    expect(client.permissions[0]?.status).toBe("closed");
  });

  test("invalid approval parameters/responses never appear as accepted", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = (method, params) =>
      method === "permission.respond"
        ? { result: { outcome: "bogus" } }
        : defaultHandler(method, params);
    const client = new AgentRunClient();
    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: async () => connection as unknown as NdjsonRpcConnection,
      },
      collectCallbacks().callbacks,
    );
    await connection.listening;
    await expect(client.respondPermission("invalid-id", "allow_once")).rejects.toThrow();
    expect(connection.requests).toHaveLength(1);
    connection.emit(pushNotification(subscriptionId, permissionRequest));
    await expect(
      client.respondPermission(permissionRequest.payload.permissionRequestId, "deny_once"),
    ).rejects.toThrow();
    expect(client.permissions[0]?.status).toBe("pending");
    client.shutdown();
    await running;
    expect(client.permissions[0]?.status).toBe("closed");
  });

  test("streams a successful run, dedups by sequence and rejects foreign events", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = defaultHandler;
    const { events, callbacks } = collectCallbacks();
    const client = new AgentRunClient();

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => Promise.resolve(connection as unknown as NdjsonRpcConnection),
      },
      callbacks,
    );
    await connection.listening;

    connection.emit(pushNotification(subscriptionId, event("run.started", {}, 1)));
    connection.emit(pushNotification(subscriptionId, event("llm.text_delta", { text: "Hi" }, 2)));
    // 重复 sequence：应被丢弃。
    connection.emit(pushNotification(subscriptionId, event("llm.text_delta", { text: "Hi" }, 2)));
    // 其他 run 的事件：应被丢弃。
    connection.emit(
      pushNotification(subscriptionId, event("llm.text_delta", { text: "X" }, 3), {
        runId: "6ba7b810-9dad-41d1-80b4-00c04fd430c9",
      }),
    );
    connection.emit(
      pushNotification(
        subscriptionId,
        event(
          "run.finished",
          {
            status: "succeeded",
            reason: "completed",
            finalText: "Hi",
            steps: 1,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
          4,
        ),
      ),
    );

    expect((await running).kind).toBe("finished");
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(connection.closed).toBe(true);
  });

  test("reconnects with the afterSequence cursor and replays missing events", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    first.requestHandler = defaultHandler;
    second.requestHandler = defaultHandler;
    const { events, callbacks } = collectCallbacks();
    const { connect } = connectSequence([first, second]);
    const client = new AgentRunClient();

    const running = client.run(
      { goal: "x", workspaceRoot: "/w", endpoint, connect, reconnectDelayMs: 0 },
      callbacks,
    );
    await first.listening;
    first.emit(pushNotification(subscriptionId, event("llm.text_delta", { text: "A" }, 1)));
    // 连接断开，客户端应重连并续订。
    first.close();
    await second.listening;
    second.emit(
      pushNotification(
        subscriptionId,
        event(
          "run.finished",
          {
            status: "succeeded",
            reason: "completed",
            finalText: "A",
            steps: 1,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
          2,
        ),
      ),
    );

    expect((await running).kind).toBe("finished");
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    const subscribe = second.requests.find((r) => r.method === "event.subscribe");
    const subscribeParams = subscribe?.params as { afterSequence?: number } | undefined;
    expect(subscribeParams?.afterSequence).toBe(1);
  });

  test("returns connect-failed after exhausting initial attempts", async () => {
    const { callbacks } = collectCallbacks();
    const client = new AgentRunClient();
    let attempts = 0;
    const result = await client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: async () => {
          attempts += 1;
          throw new Error("refused");
        },
        reconnectDelayMs: 0,
        initialConnectAttempts: 2,
      },
      callbacks,
    );
    expect(result.kind).toBe("connect-failed");
    expect(attempts).toBe(2);
  });

  test("returns acceptance-uncertain when agent.run fails before acceptance", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = () => {
      throw new Error("response lost");
    };
    const { callbacks } = collectCallbacks();
    const client = new AgentRunClient();
    const result = await client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => Promise.resolve(connection as unknown as NdjsonRpcConnection),
      },
      callbacks,
    );
    expect(result.kind).toBe("acceptance-uncertain");
    expect(connection.closed).toBe(true);
  });

  test("preserves a definite Core application error instead of reporting uncertain acceptance", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = () => {
      throw new RpcClientError("core error -32603: invalid configuration", { code: -32603 });
    };
    const { callbacks } = collectCallbacks();
    const result = await new AgentRunClient().run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => Promise.resolve(connection as unknown as NdjsonRpcConnection),
      },
      callbacks,
    );
    expect(result).toEqual({
      kind: "request-error",
      code: -32603,
      message: "core error -32603: invalid configuration",
    });
  });

  test("does not create a run when abort happens while connect is pending", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<NdjsonRpcConnection>();
    const connection = new FakeConnection();
    connection.requestHandler = defaultHandler;
    const { callbacks } = collectCallbacks();
    const client = new AgentRunClient();

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        signal: controller.signal,
        connect: () => pending.promise,
      },
      callbacks,
    );
    controller.abort();

    // connector 永不 settle 时也应立即响应初始取消。
    expect((await running).kind).toBe("cancelled");
    pending.resolve(connection as unknown as NdjsonRpcConnection);
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.requests.some((request) => request.method === "agent.run")).toBe(false);
    expect(connection.closed).toBe(true);
  });

  test("bounds a pending reconnect for an established cancelled run", async () => {
    const controller = new AbortController();
    const first = new FakeConnection();
    first.requestHandler = defaultHandler;
    const reconnectStarted = Promise.withResolvers<void>();
    const neverConnect = new Promise<NdjsonRpcConnection>(() => {});
    let attempts = 0;
    const client = new AgentRunClient();

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        signal: controller.signal,
        reconnectDelayMs: 0,
        cancelTimeoutMs: 15,
        connect: () => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.resolve(first as unknown as NdjsonRpcConnection);
          }
          reconnectStarted.resolve();
          return neverConnect;
        },
      },
      collectCallbacks().callbacks,
    );
    await first.listening;
    first.close();
    await reconnectStarted.promise;
    controller.abort();

    expect((await running).kind).toBe("cancelled");
    expect(attempts).toBe(2);
  });

  test("bounds a pending subscribe request after cancellation", async () => {
    const controller = new AbortController();
    const first = new FakeConnection();
    const second = new FakeConnection();
    first.requestHandler = defaultHandler;
    const subscribeStarted = Promise.withResolvers<void>();
    second.requestHandler = (method) => {
      if (method === "event.subscribe") {
        subscribeStarted.resolve();
        return new Promise(() => {});
      }
      return defaultHandler(method, {});
    };
    const { connect } = connectSequence([first, second]);
    const client = new AgentRunClient();

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        signal: controller.signal,
        reconnectDelayMs: 0,
        cancelTimeoutMs: 15,
        connect,
      },
      collectCallbacks().callbacks,
    );
    await first.listening;
    first.close();
    await subscribeStarted.promise;
    controller.abort();

    expect((await running).kind).toBe("cancelled");
    expect(second.closed).toBe(true);
  });

  test("keeps reconnecting an established run after cancellation until its deadline", async () => {
    const controller = new AbortController();
    const first = new FakeConnection();
    first.requestHandler = defaultHandler;
    const disconnected = Promise.withResolvers<void>();
    const statuses: string[] = [];
    let attempts = 0;
    const client = new AgentRunClient();

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        signal: controller.signal,
        reconnectDelayMs: 0,
        cancelTimeoutMs: 15,
        connect: async () => {
          attempts += 1;
          if (attempts === 1) {
            return first as unknown as NdjsonRpcConnection;
          }
          throw new Error("still disconnected");
        },
      },
      {
        onEvent: () => {},
        onStatus: (status) => {
          statuses.push(status.state);
          if (status.state === "disconnected") {
            disconnected.resolve();
          }
        },
      },
    );
    await first.listening;
    first.close();
    await disconnected.promise;
    controller.abort();

    expect((await running).kind).toBe("cancelled");
    expect(attempts).toBeGreaterThan(2);
    expect(statuses).toContain("cancelling");
  });

  test("shutdown interrupts a pending connect and closes a late socket", async () => {
    const pending = Promise.withResolvers<NdjsonRpcConnection>();
    const connection = new FakeConnection();
    connection.requestHandler = defaultHandler;
    const { callbacks } = collectCallbacks();
    const client = new AgentRunClient();
    let closeCalls = 0;
    const originalClose = connection.close.bind(connection);
    connection.close = () => {
      closeCalls += 1;
      originalClose();
    };

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => pending.promise,
      },
      callbacks,
    );
    client.shutdown();

    expect((await running).kind).toBe("cancelled");
    pending.resolve(connection as unknown as NdjsonRpcConnection);
    await Promise.resolve();
    await Promise.resolve();
    expect(closeCalls).toBe(1);
  });

  test("shutdown releases the active connection and notification listener exactly once", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = defaultHandler;
    const { callbacks } = collectCallbacks();
    const client = new AgentRunClient();
    let closeCalls = 0;
    const originalClose = connection.close.bind(connection);
    connection.close = () => {
      closeCalls += 1;
      originalClose();
    };

    const running = client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => Promise.resolve(connection as unknown as NdjsonRpcConnection),
      },
      callbacks,
    );
    await connection.listening;
    client.shutdown();
    client.shutdown();

    expect((await running).kind).toBe("cancelled");
    expect(closeCalls).toBe(1);
    expect(connection.closed).toBe(true);
    expect(connection.listenerCount).toBe(0);
  });

  test("converts a throwing status callback into internal-error", async () => {
    const connection = new FakeConnection();
    connection.requestHandler = defaultHandler;
    const client = new AgentRunClient();
    const result: AgentRunClientResult = await client.run(
      {
        goal: "x",
        workspaceRoot: "/w",
        endpoint,
        connect: () => Promise.resolve(connection as unknown as NdjsonRpcConnection),
      },
      {
        onEvent: () => {},
        onStatus: () => {
          throw new Error("callback failure");
        },
      },
    );
    expect(result.kind).toBe("internal-error");
  });
});

describe("AgentRunClient session compaction replay", () => {
  test("uses an independent cursor across reconnect and deduplicates session progress", async () => {
    const first = new FakeConnection(),
      second = new FakeConnection();
    const sessionSubscription = "950e8400-e29b-41d4-a716-446655440002";
    const compactionId = "950e8400-e29b-41d4-a716-446655440003";
    const started = {
      sessionId,
      sessionSequence: 1,
      timestamp: "2026-09-17T00:00:00.000Z",
      durable: true,
      type: "session.compaction_started",
      payload: { compactionId, reason: "threshold", tokensBefore: 90000 },
    };
    const pushSession = (connection: FakeConnection, pushed: unknown) =>
      connection.emit({
        jsonrpc: "2.0",
        method: "event.push",
        params: { subscriptionId: sessionSubscription, event: pushed },
      });
    first.requestHandler = (method, params) => {
      if (method === "session.subscribe") {
        pushSession(first, started);
        pushSession(first, started);
        setTimeout(() => first.close(), 0);
        return { result: { subscriptionId: sessionSubscription, sessionId, latestSequence: 1 } };
      }
      return defaultHandler(method, params);
    };
    second.requestHandler = (method, params) => {
      if (method === "session.subscribe") {
        expect(Reflect.get(params, "afterSequence")).toBe(1);
        pushSession(second, started);
        pushSession(second, {
          ...started,
          sessionSequence: 2,
          type: "session.compaction_failed",
          payload: { compactionId, reason: "threshold", code: "summary_failed", message: "failed" },
        });
        second.emit(
          pushNotification(subscriptionId, { ...runFinished(), sessionId, runId, sequence: 1 }),
        );
        return { result: { subscriptionId: sessionSubscription, sessionId, latestSequence: 2 } };
      }
      return defaultHandler(method, params);
    };
    const sequence = connectSequence([first, second]);
    const { callbacks } = collectCallbacks();
    const progress: string[] = [];
    callbacks.onCompaction = (event) => progress.push(event.type);
    const result = await new AgentRunClient().run(
      {
        goal: "goal",
        workspaceRoot: "/workspace",
        endpoint,
        connect: sequence.connect,
        reconnectDelayMs: 0,
      },
      callbacks,
    );
    expect(result.kind).toBe("finished");
    expect(progress).toEqual(["session.compaction_started", "session.compaction_failed"]);
    expect(first.listenerCount + second.listenerCount).toBe(0);
  });
});

test("approval stays responsive while the independent session subscription is pending", async () => {
  const connection = new FakeConnection();
  const sessionGate = Promise.withResolvers<unknown>();
  const sessionRequested = Promise.withResolvers<void>();
  connection.requestHandler = (method, params) => {
    if (method === "session.subscribe") {
      sessionRequested.resolve();
      return sessionGate.promise;
    }
    if (method === "permission.respond") return { result: { outcome: "accepted" } };
    return defaultHandler(method, params);
  };
  const client = new AgentRunClient();
  const { callbacks } = collectCallbacks();
  callbacks.onCompaction = () => {};
  const running = client.run(
    {
      goal: "goal",
      workspaceRoot: "/workspace",
      endpoint,
      connect: async () => connection as unknown as NdjsonRpcConnection,
    },
    callbacks,
  );
  await sessionRequested.promise;
  connection.emit(pushNotification(subscriptionId, permissionRequest));
  expect(
    await client.respondPermission(permissionRequest.payload.permissionRequestId, "allow_once"),
  ).toEqual({ outcome: "accepted" });
  sessionGate.resolve({
    result: {
      subscriptionId: "950e8400-e29b-41d4-a716-446655440001",
      sessionId,
      latestSequence: 0,
    },
  });
  connection.emit(pushNotification(subscriptionId, runFinished()));
  expect((await running).kind).toBe("finished");
});
