import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionController, type SessionControllerEvent } from "../../packages/client/src/index.ts";
import { CoreApp } from "../../packages/core/src/index.ts";
import { startAnthropicMock } from "./helpers/anthropic-mock.ts";

describe("SessionController mirrored timeline (integration)", () => {
  test("keeps two controllers on one session synchronized through a complete turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-controller-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "minicode-controller-workspace-"));
    await writeFile(join(workspace, "README.md"), "controller integration\n", "utf8");
    const mock = startAnthropicMock({ delayMs: 30 });
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
    const firstEvents: SessionControllerEvent[] = [];
    const secondEvents: SessionControllerEvent[] = [];
    const firstCommitted = Promise.withResolvers<void>();
    const secondCommitted = Promise.withResolvers<void>();
    const first = new SessionController({
      endpoint,
      onEvent: (event) => {
        firstEvents.push(event);
        if (event.type === "turn.committed") firstCommitted.resolve();
      },
    });
    const second = new SessionController({
      endpoint,
      onEvent: (event) => {
        secondEvents.push(event);
        if (event.type === "turn.committed") secondCommitted.resolve();
      },
    });

    try {
      const session = await first.create(workspace);
      await second.attach(session.sessionId);
      const listed = await first.list({ workspaceRoot: workspace });
      expect(listed.sessions.map((entry) => entry.sessionId)).toContain(session.sessionId);
      const accepted = await first.sendMessage("shared question");
      await Promise.all([firstCommitted.promise, secondCommitted.promise]);

      for (const events of [firstEvents, secondEvents]) {
        expect(
          events.filter(
            (event) => event.type === "turn.accepted" && event.runId === accepted.runId,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "run.event" &&
              event.event.runId === accepted.runId &&
              event.event.type === "run.finished",
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "turn.committed" && event.runId === accepted.runId,
          ),
        ).toHaveLength(1);
      }

      const textOf = (events: readonly SessionControllerEvent[]): string =>
        events
          .filter(
            (event): event is Extract<SessionControllerEvent, { type: "run.event" }> =>
              event.type === "run.event" && event.event.type === "llm.text_delta",
          )
          .map((event) => (event.event.type === "llm.text_delta" ? event.event.payload.text : ""))
          .join("");
      expect(textOf(firstEvents)).toBe(textOf(secondEvents));
      expect(textOf(firstEvents).length).toBeGreaterThan(0);

      expect(await first.cancelActiveRun()).toEqual({ outcome: "already_finished" });
      const nextSession = await first.switchToNewSession();
      expect(nextSession.sessionId).not.toBe(session.sessionId);
      expect(first.currentSession?.sessionId).toBe(nextSession.sessionId);
      expect(second.currentSession?.sessionId).toBe(session.sessionId);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await app.stop();
      await mock.stop();
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    }
  });
});
