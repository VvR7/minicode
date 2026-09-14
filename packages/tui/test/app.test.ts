import { afterEach, describe, expect, test } from "bun:test";

import type { AgentEvent, JsonRpcNotificationEnvelope } from "@minicode/protocol";
import type { NdjsonRpcConnection } from "@minicode/client";
import { createTestRenderer } from "@opentui/core/testing";

import { TuiApp } from "../src/app.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const subscriptionId = "750e8400-e29b-41d4-a716-446655440001";

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

function pushNotification(evt: AgentEvent): JsonRpcNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "event.push",
    params: { subscriptionId, event: evt },
  };
}

function finished(status: "succeeded" | "failed" | "cancelled", finalText = "done"): AgentEvent {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const base = { finalText, steps: 1, usage };
  if (status === "succeeded") {
    return event("run.finished", { ...base, status: "succeeded", reason: "completed" }, 99);
  }
  if (status === "cancelled") {
    return event("run.finished", { ...base, status: "cancelled", reason: "cancelled" }, 99);
  }
  return event("run.finished", { ...base, status: "failed", reason: "llm_error" }, 99);
}

/** 可编程 fake 连接：注册 listener 并手动推送事件。 */
class FakeConnection {
  #listeners = new Set<(n: JsonRpcNotificationEnvelope) => void>();
  #listening = Promise.withResolvers<void>();

  get listening(): Promise<void> {
    return this.#listening.promise;
  }

  request(method: string): Promise<unknown> {
    if (method === "agent.run") {
      return Promise.resolve({ result: { status: "accepted", sessionId, runId, subscriptionId } });
    }
    if (method === "event.subscribe") {
      return Promise.resolve({ result: { subscriptionId, sessionId, runId } });
    }
    if (method === "agent.cancel") {
      return Promise.resolve({ result: { outcome: "cancellation_requested" } });
    }
    return Promise.reject(new Error(`unexpected method: ${method}`));
  }

  onNotification(listener: (n: JsonRpcNotificationEnvelope) => void): () => void {
    this.#listeners.add(listener);
    this.#listening.resolve();
    return () => this.#listeners.delete(listener);
  }

  waitUntilClosed(): Promise<void> {
    return new Promise(() => {});
  }

  close(): void {}

  emit(notification: JsonRpcNotificationEnvelope): void {
    for (const listener of this.#listeners) {
      listener(notification);
    }
  }
}

const renderers: { destroy(): void }[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy();
  }
});

async function startApp(connection: FakeConnection) {
  const setup = await createTestRenderer({ width: 60, height: 10, exitOnCtrlC: false });
  renderers.push(setup.renderer);
  const app = new TuiApp();
  const codePromise = app.run({
    goal: "summarize",
    workspaceRoot: "/workspace",
    endpoint: { host: "127.0.0.1", port: 7437 },
    createRenderer: async () => setup.renderer,
    connect: async () => connection as unknown as NdjsonRpcConnection,
    reconnectDelayMs: 0,
  });
  return { setup, codePromise };
}

describe("TuiApp", () => {
  test("renders streamed events and quits with 0 after a successful run", async () => {
    const connection = new FakeConnection();
    const { setup, codePromise } = await startApp(connection);
    await connection.listening;

    connection.emit(pushNotification(event("run.started", {}, 1)));
    connection.emit(pushNotification(event("llm.text_delta", { text: "Hello" }, 2)));
    connection.emit(pushNotification(finished("succeeded", "Hello")));

    await setup.waitForFrame((frame) => frame.includes("Hello"));
    setup.mockInput.pressKey("q");

    expect(await codePromise).toBe(0);
  });

  test("returns 1 when the run fails", async () => {
    const connection = new FakeConnection();
    const { setup, codePromise } = await startApp(connection);
    await connection.listening;

    connection.emit(pushNotification(finished("failed", "")));
    await setup.waitForFrame((frame) => frame.includes("failed"));
    setup.mockInput.pressKey("q");

    expect(await codePromise).toBe(1);
  });

  test("first q cancels, second q forces exit 130", async () => {
    const connection = new FakeConnection();
    const { setup, codePromise } = await startApp(connection);
    await connection.listening;

    connection.emit(pushNotification(event("run.started", {}, 1)));
    await setup.waitForFrame((frame) => frame.includes("running"));

    setup.mockInput.pressKey("q");
    await setup.waitForFrame((frame) => frame.includes("cancelling"));

    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(130);
  });

  test("Ctrl-C during a run requests cancel, then q exits 130", async () => {
    const connection = new FakeConnection();
    const { setup, codePromise } = await startApp(connection);
    await connection.listening;

    connection.emit(pushNotification(event("run.started", {}, 1)));
    await setup.waitForFrame((frame) => frame.includes("running"));

    setup.mockInput.pressCtrlC();
    await setup.waitForFrame((frame) => frame.includes("cancelling"));

    setup.mockInput.pressKey("q");
    expect(await codePromise).toBe(130);
  });
});
