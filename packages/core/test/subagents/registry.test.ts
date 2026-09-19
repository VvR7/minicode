import { expect, test } from "bun:test";
import { SubagentRegistry, type SubagentResult } from "../../src/subagents/registry.ts";
import { createAgentResultTool } from "../../src/subagents/result-tool.ts";
import { ToolError } from "../../src/tools/types.ts";
import { SESSION_A, SESSION_B, RUN_A, RUN_B } from "../agent/test-helpers.ts";
const child = crypto.randomUUID();
const signal = () => new AbortController().signal;
const result = (childRunId: string, name: string, content: string): SubagentResult => ({
  childRunId,
  name,
  status: "succeeded",
  reason: "completed",
  steps: 1,
  content,
});

test("background pending query does not consume delivery; completed results deliver once", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  const deferred = Promise.withResolvers<SubagentResult>();
  registry.register(child, "reviewer", true, new AbortController(), deferred.promise);
  expect(
    JSON.parse((await registry.result(SESSION_A, RUN_A, child, false, signal())).content).status,
  ).toBe("running");
  expect(await registry.deliver(false, signal())).toEqual([]);
  deferred.resolve(result(child, "reviewer", "review complete"));
  const messages = await registry.deliver(true, signal());
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("review complete");
  expect(await registry.deliver(true, signal())).toEqual([]);
  expect(
    JSON.parse((await registry.result(SESSION_A, RUN_A, child, true, signal())).content).status,
  ).toBe("succeeded");
  await registry.close();
});

test("explicit terminal query and sync result prevent duplicate automatic delivery", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  registry.register(
    child,
    "reviewer",
    true,
    new AbortController(),
    Promise.resolve(result(child, "reviewer", "result")),
  );
  expect((await registry.result(SESSION_A, RUN_A, child, true, signal())).content).toContain(
    "result",
  );
  registry.register(
    crypto.randomUUID(),
    "planner",
    false,
    new AbortController(),
    Promise.resolve(result(child, "planner", "sync")),
  );
  expect(await registry.deliver(true, signal())).toEqual([]);
  expect(
    createAgentResultTool(registry, SESSION_A, RUN_A).timeoutMs?.({
      childRunId: child,
      wait: true,
    }),
  ).toBeNull();
  await registry.close();
});

test("foreign session, parent run and unknown identity are uniformly unavailable", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  registry.register(
    child,
    "reviewer",
    true,
    new AbortController(),
    Promise.resolve(result(child, "reviewer", "private")),
  );
  for (const [session, run, id] of [
    [SESSION_B, RUN_A, child],
    [SESSION_A, RUN_B, child],
    [SESSION_A, RUN_A, crypto.randomUUID()],
  ] as const)
    await expect(registry.result(session, run, id, true, signal())).rejects.toMatchObject({
      code: "not_found",
    });
  await registry.close();
  await expect(registry.result(SESSION_A, RUN_A, child, false, signal())).rejects.toMatchObject({
    code: "not_found",
  });
});

test("background failures are observed and exposed in delivery and queried tool result", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  registry.register(
    child,
    "reviewer",
    true,
    new AbortController(),
    Promise.resolve({
      childRunId: child,
      name: "reviewer",
      status: "failed",
      reason: "llm_error",
      errorCode: "context_limit_exceeded",
      steps: 4,
      content: "failure detail",
    }),
  );
  const messages = await registry.deliver(true, signal());
  expect(messages[0]).toContain('"status":"failed"');
  expect(messages[0]).toContain("failure detail");
  await expect(registry.result(SESSION_A, RUN_A, child, true, signal())).rejects.toMatchObject({
    code: "io_error",
    output: {
      content: JSON.stringify({
        childRunId: child,
        name: "reviewer",
        status: "failed",
        reason: "llm_error",
        errorCode: "context_limit_exceeded",
        steps: 4,
        content: "failure detail",
      }),
    },
  });
  await registry.close();
});

test("cancelled execution exposes the same structured terminal shape", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  registry.register(
    child,
    "reviewer",
    true,
    new AbortController(),
    Promise.reject(new ToolError("tool_cancelled", "cancelled")),
  );
  await expect(registry.result(SESSION_A, RUN_A, child, true, signal())).rejects.toMatchObject({
    code: "tool_cancelled",
    output: {
      content: JSON.stringify({
        childRunId: child,
        name: "reviewer",
        status: "cancelled",
        reason: "cancelled",
        errorCode: "tool_cancelled",
        steps: 0,
        content: "cancelled",
      }),
    },
  });
  await registry.close();
});

test("cancelled waiter and registry close abort and drain all owned executions", async () => {
  const registry = new SubagentRegistry(SESSION_A, RUN_A);
  const controller = new AbortController();
  const execution = new Promise<SubagentResult>((_resolve, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(new ToolError("tool_cancelled", "cancelled")),
      { once: true },
    ),
  );
  registry.register(child, "reviewer", true, controller, execution);
  const waiter = new AbortController();
  const pending = registry.result(SESSION_A, RUN_A, child, true, waiter.signal);
  waiter.abort();
  await expect(pending).rejects.toMatchObject({ code: "tool_cancelled" });
  await registry.close();
  expect(controller.signal.aborted).toBe(true);
  expect(await registry.deliver(false, signal())).toEqual([]);
});
