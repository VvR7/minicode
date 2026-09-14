import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@minicode/protocol";
import { SessionEventBus } from "../../src/events/session-event-bus.ts";
import { createMemoryStore, seedSession } from "../session/test-helpers.ts";
import {
  CLIENT_MESSAGE_A,
  RUN_A,
  RUN_B,
  SESSION_A,
  SESSION_B,
  TURN_A,
  TURN_B,
} from "../session/test-helpers.ts";

const HOME = "/session-event-home";

/** 构造不含 sequence 的 accepted 输入。 */
function accepted(sessionId = SESSION_A) {
  return {
    sessionId,
    timestamp: new Date().toISOString(),
    durable: true as const,
    type: "session.turn_accepted" as const,
    payload: {
      turnId: sessionId === SESSION_A ? TURN_A : TURN_B,
      runId: sessionId === SESSION_A ? RUN_A : RUN_B,
      clientMessageId: CLIENT_MESSAGE_A,
      userMessage: "hello",
    },
  };
}

/** 构造不含 sequence 的 finished 输入。 */
function finished(sessionId = SESSION_A) {
  return {
    sessionId,
    timestamp: new Date().toISOString(),
    durable: true as const,
    type: "session.turn_finished" as const,
    payload: {
      turnId: sessionId === SESSION_A ? TURN_A : TURN_B,
      runId: sessionId === SESSION_A ? RUN_A : RUN_B,
      status: "succeeded" as const,
      reason: "completed" as const,
    },
  };
}

describe("SessionEventBus", () => {
  test("keeps replay paused until activation and preserves replay/live order", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const bus = new SessionEventBus(store);
    expect((await bus.publish(accepted())).ok).toBe(true);
    const events: SessionEvent[] = [];
    const subscribed = await bus.subscribe(
      SESSION_A,
      (event) => {
        events.push(event);
      },
      0,
      undefined,
      true,
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    expect(subscribed.value.latestSequence).toBe(1);
    await bus.publish(finished());
    await Bun.sleep(0);
    expect(events).toEqual([]);

    subscribed.value.subscription.activate();
    await Bun.sleep(0);
    expect(events.map((event) => event.sessionSequence)).toEqual([1, 2]);
    expect(bus.subscriptionCount(SESSION_A)).toBe(1);
    subscribed.value.subscription.dispose();
    expect(await subscribed.value.subscription.closed).toBe("disposed");
    expect(bus.subscriptionCount(SESSION_A)).toBe(0);
  });

  test("isolates sequence domains and resumes from the durable cursor after restart", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    seedSession(storage, HOME, SESSION_B);
    const bus = new SessionEventBus(store);
    const [a, b] = await Promise.all([
      bus.publish(accepted(SESSION_A)),
      bus.publish(accepted(SESSION_B)),
    ]);
    expect(a.ok && a.value.sessionSequence).toBe(1);
    expect(b.ok && b.value.sessionSequence).toBe(1);
    await bus.publish(finished(SESSION_A));

    const restarted = new SessionEventBus(store);
    const replay: SessionEvent[] = [];
    const subscribed = await restarted.subscribe(
      SESSION_A,
      (event) => {
        replay.push(event);
      },
      1,
    );
    expect(subscribed.ok).toBe(true);
    await Bun.sleep(0);
    expect(replay.map((event) => event.type)).toEqual(["session.turn_finished"]);
    if (subscribed.ok) subscribed.value.subscription.dispose();
  });

  test("returns typed invalid, storage, and replay-overflow failures", async () => {
    const { store, storage } = createMemoryStore(HOME);
    seedSession(storage, HOME, SESSION_A);
    const bus = new SessionEventBus(store, { maxQueueEvents: 1 });
    const invalid = await bus.publish({ ...accepted(), durable: false });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_event" } });

    storage.appendError = new Error("disk");
    const failed = await bus.publish(accepted());
    expect(failed).toMatchObject({ ok: false, error: { code: "session_store_error" } });
    storage.appendError = undefined;
    await bus.publish(accepted());
    await bus.publish(finished());
    const overflow = await bus.subscribe(SESSION_A, () => {}, 0, undefined, true);
    expect(overflow).toMatchObject({ ok: false, error: { code: "subscriber_overflow" } });
  });
});
