import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { markIncompleteRunsRestarted } from "../../src/run/restart.ts";
import { SESSION_A, SESSION_B, RUN_A, RUN_B } from "../agent/test-helpers.ts";

function timestamp(): string {
  return new Date().toISOString();
}

describe("markIncompleteRunsRestarted", () => {
  test("marks a journal without run.finished as core_restarted", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-restart-"));
    try {
      const store = new EventStore(home);
      const bus = new EventBus(store);
      await bus.publish({
        sessionId: SESSION_A,
        runId: RUN_A,
        timestamp: timestamp(),
        durable: true,
        type: "run.started",
        payload: {},
      });

      await markIncompleteRunsRestarted(bus, store, home);

      const read = await store.read(SESSION_A, RUN_A);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.finished).toBe(true);
      const finished = read.value.events.find((e) => e.type === "run.finished");
      expect(finished?.payload).toMatchObject({ status: "failed", reason: "core_restarted" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skips runs that already finished", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-restart-"));
    try {
      const store = new EventStore(home);
      const bus = new EventBus(store);
      await bus.publish({
        sessionId: SESSION_B,
        runId: RUN_B,
        timestamp: timestamp(),
        durable: true,
        type: "run.started",
        payload: {},
      });
      await bus.publish({
        sessionId: SESSION_B,
        runId: RUN_B,
        timestamp: timestamp(),
        durable: true,
        type: "run.finished",
        payload: {
          status: "succeeded",
          reason: "completed",
          finalText: "done",
          steps: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });

      await markIncompleteRunsRestarted(bus, store, home);

      const read = await store.read(SESSION_B, RUN_B);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const finished = read.value.events.filter((e) => e.type === "run.finished");
      expect(finished).toHaveLength(1);
      expect(finished[0]?.payload).toMatchObject({ status: "succeeded" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
