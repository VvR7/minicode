import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventPushNotificationSchema,
  SESSION_CREATE_METHOD,
  SESSION_GET_HISTORY_METHOD,
  SESSION_GET_METHOD,
  SESSION_LIST_METHOD,
  SESSION_SEND_MESSAGE_METHOD,
  SESSION_SUBSCRIBE_METHOD,
  SessionCreateResultSchema,
  SessionGetHistoryResultSchema,
  SessionGetResultSchema,
  SessionListResultSchema,
  SessionSendMessageResultSchema,
  SessionSubscribeResultSchema,
  isSessionEvent,
  type SessionEvent,
} from "../../packages/protocol/src/index.ts";
import { CoreApp } from "../../packages/core/src/index.ts";
import { NdjsonRpcConnection } from "../../packages/client/src/index.ts";
import { startAnthropicMock } from "./helpers/anthropic-mock.ts";

/** 在固定 deadline 内等待跨连接事件条件。 */
async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

/** 从 mock provider 请求中安全提取 provider messages。 */
function providerMessages(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || !("messages" in body)) return [];
  const messages = body.messages;
  return Array.isArray(messages) ? messages : [];
}

describe("persistent session lifecycle (integration)", () => {
  test("keeps two observers synchronized and commits two-round history before turn_finished", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-session-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-session-workspace-"));
    await writeFile(join(workspace, "README.md"), "shared workspace context\n", "utf8");
    const mock = startAnthropicMock({ delayMs: 50 });
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, logLevel: "error", homeDirectory: home },
      {
        LLM_API_KEY: "test-key",
        LLM_BASE_URL: mock.url,
        LLM_MODEL: "test-model",
        LLM_CONTEXT_WINDOW_TOKENS: "100000",
        LLM_MAX_OUTPUT_TOKENS: "4096",
        MINICODE_TRACE_ENABLED: "false",
      },
    );
    const endpoint = app.start();
    const firstClient = await NdjsonRpcConnection.connect(endpoint);
    const secondClient = await NdjsonRpcConnection.connect(endpoint);
    const firstEvents: SessionEvent[] = [];
    const secondEvents: SessionEvent[] = [];
    const order: string[] = [];
    const stopFirst = firstClient.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (!parsed.success || !isSessionEvent(parsed.data.params.event)) return;
      firstEvents.push(parsed.data.params.event);
      order.push(`event:${parsed.data.params.event.type}`);
    });
    const stopSecond = secondClient.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (!parsed.success || !isSessionEvent(parsed.data.params.event)) return;
      secondEvents.push(parsed.data.params.event);
    });

    try {
      const created = await firstClient.request(
        SESSION_CREATE_METHOD,
        { workspaceRoot: workspace },
        SessionCreateResultSchema,
        { requestId: "create" },
      );
      const sessionId = created.result.session.sessionId;
      expect(created.result.session).toMatchObject({ mode: "chat", status: "idle" });

      const [firstSubscription, secondSubscription] = await Promise.all([
        firstClient.request(
          SESSION_SUBSCRIBE_METHOD,
          { sessionId, afterSequence: 0 },
          SessionSubscribeResultSchema,
          { requestId: "subscribe-1" },
        ),
        secondClient.request(
          SESSION_SUBSCRIBE_METHOD,
          { sessionId, afterSequence: 0 },
          SessionSubscribeResultSchema,
          { requestId: "subscribe-2" },
        ),
      ]);
      expect(firstSubscription.result.latestSequence).toBe(0);
      expect(secondSubscription.result.latestSequence).toBe(0);

      const firstAccepted = await firstClient.request(
        SESSION_SEND_MESSAGE_METHOD,
        { sessionId, clientMessageId: crypto.randomUUID(), content: "first question" },
        SessionSendMessageResultSchema,
        { requestId: "turn-1" },
      );
      order.push("response:accepted");
      expect(firstAccepted.result.status).toBe("accepted");
      await waitFor(
        () =>
          firstEvents.some(
            (event) =>
              event.type === "session.turn_finished" &&
              event.payload.turnId === firstAccepted.result.turnId,
          ) &&
          secondEvents.some(
            (event) =>
              event.type === "session.turn_finished" &&
              event.payload.turnId === firstAccepted.result.turnId,
          ),
      );
      expect(order[0]).toBe("response:accepted");
      expect(firstEvents.map((event) => event.type)).toEqual([
        "session.turn_accepted",
        "session.turn_finished",
      ]);
      expect(secondEvents).toEqual(firstEvents);

      const firstHistory = await firstClient.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId },
        SessionGetHistoryResultSchema,
        { requestId: "history-1" },
      );
      expect(firstHistory.result.turns[0]).toMatchObject({
        turnId: firstAccepted.result.turnId,
        status: "succeeded",
        includedInContext: true,
      });

      const secondAccepted = await firstClient.request(
        SESSION_SEND_MESSAGE_METHOD,
        { sessionId, clientMessageId: crypto.randomUUID(), content: "second question" },
        SessionSendMessageResultSchema,
        { requestId: "turn-2" },
      );
      // 请求连接断开不拥有 run；另一个订阅者仍应观察到同一终态。
      firstClient.close();
      await waitFor(() =>
        secondEvents.some(
          (event) =>
            event.type === "session.turn_finished" &&
            event.payload.turnId === secondAccepted.result.turnId,
        ),
      );

      const history = await secondClient.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId },
        SessionGetHistoryResultSchema,
        { requestId: "history-2" },
      );
      expect(history.result.turns).toHaveLength(2);
      expect(history.result.turns.every((turn) => turn.status === "succeeded")).toBe(true);
      expect(history.result.throughSessionSequence).toBe(4);

      const lastProviderRequest = mock.requestBodies.at(-1);
      const serializedMessages = JSON.stringify(providerMessages(lastProviderRequest));
      expect(serializedMessages).toContain("first question");
      expect(serializedMessages).toContain("SUMMARY:shared workspace context");
      expect(serializedMessages).toContain("second question");

      const fetched = await secondClient.request(
        SESSION_GET_METHOD,
        { sessionId },
        SessionGetResultSchema,
        { requestId: "get" },
      );
      expect(fetched.result.session).toMatchObject({ sessionId, status: "idle" });
      const listed = await secondClient.request(
        SESSION_LIST_METHOD,
        { workspaceRoot: workspace },
        SessionListResultSchema,
        { requestId: "list" },
      );
      expect(listed.result.sessions.map((session) => session.sessionId)).toContain(sessionId);
    } finally {
      stopFirst();
      stopSecond();
      firstClient.close();
      secondClient.close();
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  });
});
