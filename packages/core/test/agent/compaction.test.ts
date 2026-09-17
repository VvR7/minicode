import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ExecutionContext } from "../../src/agent/context.ts";
import { AgentLoop, type ContextCompactionHook } from "../../src/agent/loop.ts";
import { LlmError } from "../../src/llm/errors.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import {
  createBus,
  FakeProvider,
  SESSION_A,
  RUN_A,
  textResponse,
  toolResponse,
  toolCall,
  usage,
  type FakeTurn,
} from "./test-helpers.ts";

/** 构造小窗口循环并记录工具副作用，验证压缩不会重复执行工具。 */
function setup(turns: FakeTurn[], compact: ContextCompactionHook, enabled = true) {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "echo",
    inputSchema: z.object({}),
    async execute() {
      executions += 1;
      return { content: "tool result", isError: false, outputBytes: 11, truncated: false };
    },
  });
  const provider = new FakeProvider(turns);
  const context = new ExecutionContext({
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceRoot: "/workspace",
    goal: "latest request",
  });
  const loop = new AgentLoop(provider, registry, new ToolInvoker(registry), createBus(), {
    systemPrompt: "system",
    contextWindowTokens: 1000,
    compactionConfig: { enabled, reserveTokens: 100, keepRecentTokens: 100 },
    compact,
  });
  return { loop, context, provider, executions: () => executions };
}

describe("run compaction", () => {
  test("checks after tools using latest usage and preserves the complete audit", async () => {
    const reasons: string[] = [];
    const response = {
      ...toolResponse([toolCall("call", "echo")]),
      usage: usage({ inputTokens: 940, cacheReadInputTokens: 10 }),
    };
    const h = setup(
      [{ response }, { response: textResponse("done") }],
      async (entries, tokens, reason) => {
        reasons.push(reason);
        expect(tokens).toBeGreaterThan(950);
        return entries.slice(1);
      },
    );
    const completion = await h.loop.run(h.context, new AbortController().signal);
    expect(completion.status).toBe("succeeded");
    expect(reasons).toEqual(["threshold"]);
    expect(h.executions()).toBe(1);
    expect(completion.messages).toHaveLength(4);
    expect(completion.messages[0]?.content).toEqual([{ type: "text", text: "latest request" }]);
    expect(completion.messageIds).toHaveLength(4);
    expect(h.provider.calls[1]?.messages[0]?.role).toBe("assistant");
    expect(Object.keys(h.provider.calls[1]?.messages[0] ?? {})).toEqual(["role", "content"]);
  });

  test("context failure retries the same step once without replaying tools", async () => {
    let compressions = 0;
    const h = setup(
      [
        { response: toolResponse([toolCall("call", "echo")]) },
        { error: new LlmError("context_limit_exceeded", "overflow") },
        { response: textResponse("done") },
      ],
      async (entries, _tokens, reason) => {
        compressions += 1;
        expect(reason).toBe("context_error");
        return entries;
      },
    );
    const completion = await h.loop.run(h.context, new AbortController().signal);
    expect(completion.status).toBe("succeeded");
    expect(completion.steps).toBe(2);
    expect(h.provider.calls).toHaveLength(3);
    expect(h.executions()).toBe(1);
    expect(compressions).toBe(1);
  });

  test("a second overflow stops and reports a safe context error", async () => {
    let compressions = 0;
    const error = new LlmError("context_limit_exceeded", "secret provider text");
    const h = setup([{ error }, { error }], async (entries) => {
      compressions += 1;
      return entries;
    });
    const completion = await h.loop.run(h.context, new AbortController().signal);
    expect(completion.status).toBe("failed");
    expect(completion.error?.code).toBe("context_limit_exceeded");
    expect(JSON.stringify(completion)).not.toContain("secret provider text");
    expect(compressions).toBe(1);
    expect(h.provider.calls).toHaveLength(2);
  });

  test("disabled automatic compaction does not retry overflow", async () => {
    const h = setup(
      [{ error: new LlmError("context_limit_exceeded", "overflow") }],
      async () => {
        throw new Error("unexpected compaction");
      },
      false,
    );
    const completion = await h.loop.run(h.context, new AbortController().signal);
    expect(completion.error?.code).toBe("context_limit_exceeded");
    expect(h.provider.calls).toHaveLength(1);
  });

  test("no evictable messages reports context limit without recursive shrinking", async () => {
    const h = setup(
      [{ error: new LlmError("context_limit_exceeded", "overflow") }],
      async () => undefined,
    );
    const completion = await h.loop.run(h.context, new AbortController().signal);
    expect(completion.error?.code).toBe("context_limit_exceeded");
    expect(h.provider.calls).toHaveLength(1);
  });

  test("occupancy uses one call rather than cumulative usage and resets after compaction", () => {
    const context = new ExecutionContext({
      sessionId: SESSION_A,
      runId: RUN_A,
      workspaceRoot: "/workspace",
      goal: "goal",
    });
    context.accumulateUsage(usage({ inputTokens: 500 }));
    context.accumulateUsage(usage({ inputTokens: 500 }));
    context.anchorUsage(
      usage({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
      }),
    );
    expect(context.contextTokens("system", [])).toBe(160);
    context.addToolResults([{ toolUseId: "id", content: "result", isError: false }]);
    expect(context.contextTokens("system", [])).toBeGreaterThan(160);
    context.replaceContext(context.contextEntries.slice(-1));
    expect(context.contextTokens("system", [])).toBeLessThan(160);
    expect(context.runMessages()).toHaveLength(2);
  });
});
