import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApp, SessionStore } from "../../packages/core/src/index.ts";
import {
  SessionController,
  RpcClientError,
  type SessionControllerEvent,
} from "../../packages/client/src/index.ts";
import { createBarrier, startScriptedAnthropicMock } from "./helpers/scripted-anthropic-mock.ts";

/** 解包必须成功的会话准备结果。 */
function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("setup failed");
  return result.value;
}

/** 等待事件消费完成，不以渲染器 idle 作为网络完成条件。 */
async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("event did not arrive");
    await Bun.sleep(2);
  }
}

describe("Stage4 shared client compaction", () => {
  test("focus, busy, multi-window events and later attach replay preserve original history", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage4-client-"));
    const store = new SessionStore(home);
    const barrier = createBarrier();
    const mock = startScriptedAnthropicMock((_body, call) =>
      call === 1
        ? { kind: "text", chunks: ["answer ".repeat(100)] }
        : { kind: "text", chunks: ["summary focused on pending work"], barrier },
    );
    const app = new CoreApp(
      { host: "127.0.0.1", port: 0, homeDirectory: home, logLevel: "error" },
      {
        LLM_API_KEY: "test-key",
        LLM_BASE_URL: mock.url,
        LLM_MODEL: "test-model",
        LLM_MAX_OUTPUT_TOKENS: "4096",
        MINICODE_COMPACTION_ENABLED: "false",
        MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "100",
        MINICODE_TRACE_ENABLED: "false",
      },
    );
    const endpoint = app.start();
    const events = [[], [], []] as [
      SessionControllerEvent[],
      SessionControllerEvent[],
      SessionControllerEvent[],
    ];
    const controllers = events.map(
      (buffer) =>
        new SessionController({
          endpoint,
          onEvent: (event) => {
            buffer.push(event);
          },
        }),
    );
    const [first, second, third] = controllers;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("missing controller");
    try {
      const session = await first.create(home);
      const sessionId = session.sessionId;
      await first.sendMessage("original request ".repeat(1000));
      await waitFor(() => events[0].some((event) => event.type === "turn.committed"));
      await second.attach(sessionId);
      const compacting = first.compact("pending work");
      await barrier.reached;
      await waitFor(() =>
        events[1].some(
          (event) =>
            event.type === "session.compaction" &&
            event.event.type === "session.compaction_started",
        ),
      );
      await expect(second.compact()).rejects.toMatchObject({ code: -32011 });
      await expect(second.sendMessage("concurrent")).rejects.toBeInstanceOf(RpcClientError);
      barrier.release();
      const result = await compacting;
      expect(result.status).toBe("compacted");
      await waitFor(() =>
        events[1].some(
          (event) =>
            event.type === "session.compaction" &&
            event.event.type === "session.compaction_finished",
        ),
      );
      await third.attach(sessionId);
      await waitFor(
        () => events[2].filter((event) => event.type === "session.compaction").length === 2,
      );
      expect(events[0].filter((event) => event.type === "session.compaction")).toHaveLength(2);
      expect(events[1].filter((event) => event.type === "session.compaction")).toHaveLength(2);
      expect(
        events[2].filter((event) => event.type === "run.event" || event.type === "turn.accepted"),
      ).toHaveLength(0);
      expect(JSON.stringify(mock.requestBodies)).toContain("pending work");
      const summaryBody = mock.requestBodies[1] as { tools: unknown[]; max_tokens: number };
      expect(summaryBody.tools ?? []).toEqual([]);
      expect(summaryBody.max_tokens).toBe(4096);
      const loaded = must(await store.load(sessionId));
      expect(loaded.turns).toHaveLength(1);
      expect(loaded.turns[0]?.messages[0]?.content[0]).toEqual({
        type: "text",
        text: "original request ".repeat(1000).trim(),
      });
      expect(loaded.compactions).toHaveLength(1);
    } finally {
      barrier.release();
      await Promise.all(controllers.map((controller) => controller.dispose()));
      await app.stop();
      await mock.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});
