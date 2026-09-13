import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@minicode/protocol";
import { EventBus, MAX_SUBSCRIBER_QUEUE_EVENTS } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import {
  deltaInput,
  finishedInput,
  MemoryJournalStorage,
  RUN_A,
  RUN_B,
  SESSION_A,
  SESSION_B,
  startedInput,
} from "./test-helpers.ts";

function createBus(storage = new MemoryJournalStorage()) {
  return { bus: new EventBus(new EventStore("/memory", storage)), storage };
}

describe("EventBus", () => {
  test("isolates concurrent run sequences, subscribers, and journal paths", async () => {
    const { bus, storage } = createBus();
    const receivedA: AgentEvent[] = [];
    const receivedB: AgentEvent[] = [];
    const subscribedA = await bus.subscribe(SESSION_A, RUN_A, (event) => {
      receivedA.push(event);
    });
    const subscribedB = await bus.subscribe(SESSION_B, RUN_B, (event) => {
      receivedB.push(event);
    });
    expect(subscribedA.ok).toBe(true);
    expect(subscribedB.ok).toBe(true);

    const results = await Promise.all([
      bus.publish(startedInput(SESSION_A, RUN_A)),
      bus.publish(startedInput(SESSION_B, RUN_B)),
      bus.publish({
        ...startedInput(SESSION_A, RUN_A),
        type: "step.started",
        payload: { step: 1 },
      }),
      bus.publish({
        ...startedInput(SESSION_B, RUN_B),
        type: "step.started",
        payload: { step: 1 },
      }),
    ]);
    await Promise.resolve();

    expect(results.every((result) => result.ok)).toBe(true);
    expect(receivedA.map((event) => [event.runId, event.sequence])).toEqual([
      [RUN_A, 1],
      [RUN_A, 2],
    ]);
    expect(receivedB.map((event) => [event.runId, event.sequence])).toEqual([
      [RUN_B, 1],
      [RUN_B, 2],
    ]);
    expect(storage.files.size).toBe(2);
    expect([...storage.files.keys()][0]).not.toBe([...storage.files.keys()][1]);
  });

  test("persists a durable event before broadcasting it", async () => {
    const storage = new MemoryJournalStorage();
    const originalAppend = storage.append.bind(storage);
    const gate = Promise.withResolvers<void>();
    storage.append = async (path, content, directories) => {
      await gate.promise;
      await originalAppend(path, content, directories);
    };
    const bus = new EventBus(new EventStore("/memory", storage));
    const received: AgentEvent[] = [];
    await bus.subscribe(SESSION_A, RUN_A, (event) => {
      received.push(event);
    });

    const publishing = bus.publish(startedInput());
    await Promise.resolve();
    expect(received).toEqual([]);
    gate.resolve();
    expect((await publishing).ok).toBe(true);
    await Promise.resolve();
    expect(received.map((event) => event.sequence)).toEqual([1]);
  });

  test("switches atomically from exclusive cursor replay to live events", async () => {
    const { bus } = createBus();
    await bus.publish(startedInput());
    await bus.publish({ ...startedInput(), type: "step.started", payload: { step: 1 } });
    const received: number[] = [];

    const subscribing = bus.subscribe(
      SESSION_A,
      RUN_A,
      (event) => {
        received.push(event.sequence);
      },
      1,
    );
    const publishing = bus.publish({
      ...startedInput(),
      type: "step.finished",
      payload: { step: 1, outcome: "continue" },
    });
    const [subscription, published] = await Promise.all([subscribing, publishing]);
    expect(subscription.ok).toBe(true);
    expect(published.ok).toBe(true);
    await Promise.resolve();

    expect(received).toEqual([2, 3]);
  });

  test("continues a run sequence from its durable journal after restart", async () => {
    const storage = new MemoryJournalStorage();
    const firstBus = new EventBus(new EventStore("/memory", storage));
    expect((await firstBus.publish(startedInput())).ok).toBe(true);

    const restartedBus = new EventBus(new EventStore("/memory", storage));
    const next = await restartedBus.publish({
      ...startedInput(),
      type: "step.started",
      payload: { step: 1 },
    });
    expect(next.ok && next.value.sequence).toBe(2);
  });

  test("does not reuse a transient sequence after restart or lose the exclusive cursor", async () => {
    const storage = new MemoryJournalStorage();
    const firstBus = new EventBus(new EventStore("/memory", storage));
    expect((await firstBus.publish(startedInput())).ok).toBe(true);
    expect((await firstBus.publish(deltaInput("ephemeral secret"))).ok).toBe(true);

    const restartedBus = new EventBus(new EventStore("/memory", storage));
    const next = await restartedBus.publish({
      ...startedInput(),
      type: "step.started",
      payload: { step: 1 },
    });
    expect(next.ok && next.value.sequence).toBe(3);

    const replayed: number[] = [];
    await restartedBus.subscribe(
      SESSION_A,
      RUN_A,
      (event) => {
        replayed.push(event.sequence);
      },
      2,
    );
    await Promise.resolve();
    expect(replayed).toEqual([3]);
    const journal = storage.files.get(new EventStore("/memory", storage).pathFor(SESSION_A, RUN_A));
    expect(journal).not.toContain("ephemeral secret");
  });

  test("disconnects a slow subscriber without blocking another run", async () => {
    const { bus } = createBus();
    const never = new Promise<void>(() => {});
    const slow = await bus.subscribe(SESSION_A, RUN_A, () => never);
    expect(slow.ok).toBe(true);
    if (!slow.ok) {
      return;
    }

    await bus.publish(deltaInput("first"));
    for (let index = 0; index <= MAX_SUBSCRIBER_QUEUE_EVENTS; index += 1) {
      await bus.publish(deltaInput(`queued-${index}`));
    }
    await slow.value.closed;

    expect(bus.subscriptionCount(SESSION_A, RUN_A)).toBe(0);
    const otherRun = await bus.publish(deltaInput("still-running", RUN_B));
    expect(otherRun.ok).toBe(true);
  });

  test("disconnects a subscriber whose queued event bytes exceed 4 MiB", async () => {
    const { bus } = createBus();
    const slow = await bus.subscribe(SESSION_A, RUN_A, () => new Promise<void>(() => {}));
    expect(slow.ok).toBe(true);
    if (!slow.ok) {
      return;
    }

    const largeDelta = "x".repeat(16 * 1024);
    await bus.publish(deltaInput(largeDelta));
    for (let index = 0; index < MAX_SUBSCRIBER_QUEUE_EVENTS; index += 1) {
      await bus.publish(deltaInput(largeDelta));
      if (bus.subscriptionCount(SESSION_A, RUN_A) === 0) {
        break;
      }
    }
    await slow.value.closed;
    expect(bus.subscriptionCount(SESSION_A, RUN_A)).toBe(0);
  });

  test("isolates handler failures and releases subscriptions after run completion", async () => {
    const { bus } = createBus();
    const failing = await bus.subscribe(SESSION_A, RUN_A, () => {
      throw new Error("subscriber failed");
    });
    expect(failing.ok).toBe(true);
    if (!failing.ok) {
      return;
    }
    await bus.publish(deltaInput("failure"));
    await failing.value.closed;
    expect(bus.subscriptionCount(SESSION_A, RUN_A)).toBe(0);

    const terminal: string[] = [];
    const completed = await bus.subscribe(SESSION_A, RUN_B, (event) => {
      terminal.push(event.type);
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) {
      return;
    }
    await bus.publish(finishedInput(RUN_B));
    await completed.value.closed;
    expect(terminal).toEqual(["run.finished"]);
    expect(bus.subscriptionCount(SESSION_A, RUN_B)).toBe(0);
  });

  test("bounds terminal cleanup when a subscriber handler never settles", async () => {
    const storage = new MemoryJournalStorage();
    const bus = new EventBus(new EventStore("/memory", storage), { closeGraceMs: 10 });
    const blocked = await bus.subscribe(SESSION_A, RUN_A, () => new Promise<void>(() => {}));
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;

    await bus.publish(finishedInput());
    expect(await blocked.value.closed).toBe("slow_consumer");
    expect(bus.subscriptionCount(SESSION_A, RUN_A)).toBe(0);
  });

  test("returns typed store failures without advancing or broadcasting", async () => {
    const storage = new MemoryJournalStorage();
    const bus = new EventBus(new EventStore("/memory", storage));
    storage.readError = new Error("private failure");

    expect(await bus.publish(startedInput())).toEqual({
      ok: false,
      error: {
        code: "event_store_error",
        message: "failed to read agent event journal",
        storeFailure: { code: "read_failed", message: "failed to read agent event journal" },
      },
    });

    storage.readError = undefined;
    const received: AgentEvent[] = [];
    await bus.subscribe(SESSION_A, RUN_B, (event) => {
      received.push(event);
    });
    storage.appendError = new Error("private write failure");
    expect(await bus.publish(startedInput(SESSION_A, RUN_B))).toEqual({
      ok: false,
      error: {
        code: "event_store_error",
        message: "failed to persist agent event",
        storeFailure: { code: "write_failed", message: "failed to persist agent event" },
      },
    });
    expect(received).toEqual([]);
  });

  test("rejects invalid terminal durability", async () => {
    const { bus } = createBus();
    const result = await bus.publish({ ...finishedInput(), durable: false });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_event", message: "agent event is invalid" },
    });
  });

  test("does not leak a cursor subscription created after run completion", async () => {
    const { bus } = createBus();
    const finished = await bus.publish(finishedInput());
    expect(finished.ok).toBe(true);
    const subscribed = await bus.subscribe(SESSION_A, RUN_A, () => {}, 1);
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) {
      return;
    }
    await subscribed.value.closed;

    expect(bus.subscriptionCount(SESSION_A, RUN_A)).toBe(0);
    expect(await bus.publish(deltaInput("late"))).toEqual({
      ok: false,
      error: { code: "run_finished", message: "cannot publish after run completion" },
    });
  });
});
