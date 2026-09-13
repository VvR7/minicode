import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RunManager } from "../../src/run/manager.ts";
import type { AgentRunRequest } from "../../src/run/runner.ts";
import type { RunExecutor } from "../../src/run/manager.ts";
import { SESSION_A, SESSION_B, RUN_A, RUN_B } from "../agent/test-helpers.ts";

/** 挂起直到 abort 的 executor，用于验证取消与 shutdown。 */
class HangExecutor implements RunExecutor {
  readonly aborted = new Set<AbortSignal>();

  async run(
    _request: AgentRunRequest,
    signal: AbortSignal,
    onStarted: () => Promise<void> = async () => {},
  ): Promise<void> {
    const activated = onStarted();
    const finished = new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          this.aborted.add(signal);
          resolve();
        },
        { once: true },
      );
    });
    await activated;
    await finished;
  }
}

/** 立即完成的 executor，用于验证终态清理。 */
class ImmediateExecutor implements RunExecutor {
  async run(
    _request: AgentRunRequest,
    _signal: AbortSignal,
    onStarted: () => Promise<void> = async () => {},
  ): Promise<void> {
    await onStarted();
  }
}

function request(sessionId = SESSION_A, runId = RUN_A): AgentRunRequest {
  return { sessionId, runId, goal: "x", workspaceRoot: "/workspace" };
}

/** 让 microtask 队列排空，确保 start 的 finally 清理执行完毕。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RunManager", () => {
  test("generates unique valid session and run ids", () => {
    const manager = new RunManager(new HangExecutor());
    const sessionId = manager.newSessionId();
    const runId = manager.newRunId();
    expect(z.uuid().safeParse(sessionId).success).toBe(true);
    expect(z.uuid().safeParse(runId).success).toBe(true);
    expect(sessionId).not.toBe(manager.newSessionId());
    expect(runId).not.toBe(manager.newRunId());
  });

  test("starts runs and reports active count", async () => {
    const manager = new RunManager(new HangExecutor());
    const activate = await manager.start(request());
    activate();
    expect(manager.activeCount).toBe(1);
  });

  test("cancels an active run idempotently", async () => {
    const executor = new HangExecutor();
    const manager = new RunManager(executor);
    await manager.start(request());

    expect(manager.cancel(SESSION_A, RUN_A)).toBe("cancellation_requested");
    expect(executor.aborted.size).toBe(1);
  });

  test("returns already_finished for a completed run", async () => {
    const manager = new RunManager(new ImmediateExecutor());
    const activate = await manager.start(request());
    activate();
    await flushMicrotasks();

    expect(manager.activeCount).toBe(0);
    expect(manager.cancel(SESSION_A, RUN_A)).toBe("already_finished");
  });

  test("returns not_found for an unknown run", () => {
    const manager = new RunManager(new HangExecutor());
    expect(manager.cancel(SESSION_A, RUN_A)).toBe("not_found");
  });

  test("rejects duplicate starts", async () => {
    const manager = new RunManager(new HangExecutor());
    await manager.start(request());
    expect(() => manager.start(request())).toThrow("duplicate run");
  });

  test("shutdown aborts all active runs and releases them", async () => {
    const executor = new HangExecutor();
    const manager = new RunManager(executor);
    await manager.start(request(SESSION_A, RUN_A));
    await manager.start(request(SESSION_B, RUN_B));
    expect(manager.activeCount).toBe(2);

    await manager.shutdown();

    expect(executor.aborted.size).toBe(2);
    expect(manager.activeCount).toBe(0);
  });
});
