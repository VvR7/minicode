import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { AgentRunner } from "../../src/run/runner.ts";
import { LlmError } from "../../src/llm/errors.ts";
import type { LlmProvider, LlmStreamOptions } from "../../src/llm/provider.ts";
import type { LlmMessage, LlmStreamEvent } from "../../src/llm/types.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import { environmentWithLlm, HangProvider } from "../run/test-helpers.ts";
import {
  SESSION_A,
  RUN_A,
  FakeProvider,
  createBus,
  collectEvents,
  textResponse,
  toolResponse,
  toolCall,
} from "../agent/test-helpers.ts";
/** 挂起子模型以证明父 Agent 不等待后台执行。 */
class BarrierProvider implements LlmProvider {
  readonly providerName = "barrier";
  readonly model = "child-model";
  readonly reached = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  /** 子调用到达后等待测试释放，随后返回终态。 */
  async *stream(
    _messages: readonly LlmMessage[],
    _options?: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    this.reached.resolve();
    await this.released.promise;
    yield { type: "completed", response: textResponse("background child result") };
  }
}
/** 等待父循环到达实际切点。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("background test timed out");
    await Bun.sleep(1);
  }
}

test("parent continues working then waits before final and integrates ordinary result context once", async () => {
  const workspace = await createTempWorkspace();
  const parent = new FakeProvider([
    {
      response: toolResponse([
        toolCall("spawn", "spawn_agent", { name: "reviewer", goal: "review", background: true }),
      ]),
    },
    { response: toolResponse([toolCall("read", "read", { path: "missing" })]) },
    { response: textResponse("premature final") },
    { response: textResponse("integrated final") },
  ]);
  const child = new BarrierProvider();
  const bus = createBus();
  const observed = await collectEvents(bus, SESSION_A, RUN_A);
  let factoryCalls = 0;
  const runner = new AgentRunner({
    environment: environmentWithLlm(),
    bus,
    homeDirectory: workspace,
    providerFactory: () => (factoryCalls++ === 0 ? parent : child),
  });
  let finished = false;
  const pending = runner
    .run(
      { sessionId: SESSION_A, runId: RUN_A, goal: "parent", workspaceRoot: workspace },
      new AbortController().signal,
    )
    .then((outcome) => {
      finished = true;
      return outcome;
    });
  try {
    await child.reached.promise;
    await waitFor(() => parent.calls.length === 3);
    expect(finished).toBe(false);
    const start = observed.events.find((e) => e.type === "subagent.started");
    if (start?.type !== "subagent.started") throw new Error("missing lifecycle");
    expect(start.payload.background).toBe(true);
    expect(JSON.stringify(parent.calls[1]?.messages)).toContain(start.payload.childRunId);
    child.released.resolve();
    const outcome = await pending;
    expect(outcome.completion).toMatchObject({
      status: "succeeded",
      steps: 4,
      finalText: "integrated final",
    });
    const delivered = parent.calls[3]?.messages.filter((message) =>
      message.content.some(
        (part) => part.type === "text" && part.text.startsWith("Subagent result:"),
      ),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered?.[0]?.role).toBe("user");
    expect(delivered?.[0]?.content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(delivered)).toContain("background child result");
    expect(observed.events.filter((e) => e.type === "subagent.finished")).toHaveLength(1);
  } finally {
    child.released.resolve();
    await pending;
    observed.subscription.dispose();
    await cleanupTempWorkspace(workspace);
  }
});

test("parent failure cancels and drains an already returned background child", async () => {
  const workspace = await createTempWorkspace();
  const parent = new FakeProvider([
    {
      response: toolResponse([
        toolCall("spawn", "spawn_agent", { name: "reviewer", goal: "review", background: true }),
      ]),
    },
    { error: new LlmError("invalid_response", "parent fails") },
  ]);
  const bus = createBus();
  const observed = await collectEvents(bus, SESSION_A, RUN_A);
  let factoryCalls = 0;
  const runner = new AgentRunner({
    environment: environmentWithLlm(),
    bus,
    homeDirectory: workspace,
    providerFactory: () => (factoryCalls++ === 0 ? parent : new HangProvider()),
  });
  try {
    expect(
      (
        await runner.run(
          { sessionId: SESSION_A, runId: RUN_A, goal: "parent", workspaceRoot: workspace },
          new AbortController().signal,
        )
      ).completion.status,
    ).toBe("failed");
    const start = observed.events.find((e) => e.type === "subagent.started");
    if (start?.type !== "subagent.started") throw new Error("missing lifecycle");
    const directory = join(
      workspace,
      "sessions",
      SESSION_A,
      "runs",
      RUN_A,
      "subagents",
      start.payload.childRunId,
    );
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))).toMatchObject({
      background: true,
      status: "cancelled",
    });
    expect(observed.events.find((e) => e.type === "subagent.finished")?.payload).toMatchObject({
      background: true,
      status: "cancelled",
    });
  } finally {
    observed.subscription.dispose();
    await cleanupTempWorkspace(workspace);
  }
});
