import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CANCEL_METHOD,
  AGENT_RUN_METHOD,
  AgentCancelResultSchema,
  AgentRunResultSchema,
  CORE_PING_METHOD,
  EventPushNotificationSchema,
  PongResultSchema,
} from "../../packages/protocol/src/index.ts";
import type { AgentEvent } from "../../packages/protocol/src/index.ts";
import { NdjsonRpcConnection } from "../../packages/cli/src/index.ts";
import { CoreApp, EventBus, EventStore } from "../../packages/core/src/index.ts";

const SESSION_A = "550e8400-e29b-41d4-a716-446655440020";
const RUN_A = "6ba7b810-9dad-41d1-80b4-00c04fd43020";

function makeApp(homeDirectory: string): CoreApp {
  return new CoreApp(
    { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory },
    {}, // 不含 LLM 配置，run 会以 config_error 结束。
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("agent.run lifecycle (integration)", () => {
  test("returns before the first event and survives missing LLM config", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-run-"));
    const app = makeApp(home);
    const connection = await NdjsonRpcConnection.connect(app.start());
    const order: string[] = [];
    const stopListening = connection.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (parsed.success) {
        order.push(`event:${parsed.data.params.event.type}`);
      }
    });

    try {
      const response = await connection.request(
        AGENT_RUN_METHOD,
        { goal: "summarize", workspaceRoot: "/workspace" },
        AgentRunResultSchema,
        { requestId: "run-1" },
      );
      order.push("response");

      expect(response.result.status).toBe("accepted");

      // accepted 返回时 journal 已包含 run.started，daemon 随即崩溃也可由 startup 收尾。
      const journal = await new EventStore(home).read(
        response.result.sessionId,
        response.result.runId,
      );
      expect(journal.ok).toBe(true);
      if (journal.ok) {
        expect(journal.value.events[0]?.type).toBe("run.started");
      }

      await waitFor(() => order.includes("event:run.finished"));
      // response 严格早于首个事件。
      expect(order[0]).toBe("response");

      // 缺 LLM 配置不杀 daemon：还能响应 ping。
      const pong = await connection.request(
        CORE_PING_METHOD,
        { clientName: "test", clientVersion: "0.0.0" },
        PongResultSchema,
        { requestId: "ping-1" },
      );
      expect(pong.result.serverVersion).toBe("0.1.0");
      expect(order).toContain("event:run.started");
    } finally {
      stopListening();
      connection.close();
      await app.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("keeps two concurrent runs isolated by session and run", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-run-"));
    const app = makeApp(home);
    const connection = await NdjsonRpcConnection.connect(app.start());
    const received = new Map<string, AgentEvent[]>();
    const stop = connection.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (!parsed.success) return;
      const events = received.get(parsed.data.params.subscriptionId) ?? [];
      events.push(parsed.data.params.event);
      received.set(parsed.data.params.subscriptionId, events);
    });
    const first = await connection.request(
      AGENT_RUN_METHOD,
      { goal: "a", workspaceRoot: "/workspace/a" },
      AgentRunResultSchema,
      { requestId: "run-a" },
    );
    const second = await connection.request(
      AGENT_RUN_METHOD,
      { goal: "b", workspaceRoot: "/workspace/b" },
      AgentRunResultSchema,
      { requestId: "run-b" },
    );

    try {
      expect(first.result.sessionId).not.toBe(second.result.sessionId);
      expect(first.result.runId).not.toBe(second.result.runId);
      expect(first.result.subscriptionId).not.toBe(second.result.subscriptionId);

      await waitFor(
        () =>
          (received.get(first.result.subscriptionId) ?? []).some(
            (event) => event.type === "run.finished",
          ) &&
          (received.get(second.result.subscriptionId) ?? []).some(
            (event) => event.type === "run.finished",
          ),
      );
      const firstEvents = received.get(first.result.subscriptionId) ?? [];
      const secondEvents = received.get(second.result.subscriptionId) ?? [];

      expect([...new Set(firstEvents.map((event) => event.sessionId))]).toEqual([
        first.result.sessionId,
      ]);
      expect([...new Set(secondEvents.map((event) => event.sessionId))]).toEqual([
        second.result.sessionId,
      ]);
    } finally {
      stop();
      connection.close();
      await app.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("cancel reports not_found for unknown runs and already_finished after completion", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-run-"));
    const app = makeApp(home);
    const connection = await NdjsonRpcConnection.connect(app.start());

    try {
      const unknown = await connection.request(
        AGENT_CANCEL_METHOD,
        { sessionId: SESSION_A, runId: RUN_A },
        AgentCancelResultSchema,
        { requestId: "cancel-unknown" },
      );
      expect(unknown.result.outcome).toBe("not_found");

      const run = await connection.request(
        AGENT_RUN_METHOD,
        { goal: "x", workspaceRoot: "/workspace" },
        AgentRunResultSchema,
        { requestId: "run-1" },
      );

      let outcome: string | undefined;
      await waitFor(async () => {
        const cancel = await connection.request(
          AGENT_CANCEL_METHOD,
          { sessionId: run.result.sessionId, runId: run.result.runId },
          AgentCancelResultSchema,
          { requestId: "cancel-later" },
        );
        outcome = cancel.result.outcome;
        return outcome === "already_finished";
      });
      expect(outcome).toBe("already_finished");
    } finally {
      connection.close();
      await app.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("startup marks an incomplete journal as core_restarted", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-run-"));
    try {
      // 先写一个未完成的 journal（只有 run.started）。
      const store = new EventStore(home);
      const bus = new EventBus(store);
      await bus.publish({
        sessionId: SESSION_A,
        runId: RUN_A,
        timestamp: new Date().toISOString(),
        durable: true,
        type: "run.started",
        payload: {},
      });

      const app = makeApp(home);
      app.start();

      try {
        await waitFor(async () => {
          const read = await store.read(SESSION_A, RUN_A);
          return read.ok && read.value.finished;
        });
        const read = await store.read(SESSION_A, RUN_A);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        const finished = read.value.events.find((e) => e.type === "run.finished");
        expect(finished?.payload).toMatchObject({ status: "failed", reason: "core_restarted" });
      } finally {
        await app.stop();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
