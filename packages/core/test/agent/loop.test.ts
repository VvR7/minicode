import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@minicode/protocol";
import { ExecutionContext } from "../../src/agent/context.ts";
import { AgentLoop } from "../../src/agent/loop.ts";
import type { RunCompletion } from "../../src/run/completion.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool } from "../../src/tools/types.ts";
import { builtinTools } from "../../src/tools/builtin/index.ts";
import { LlmError } from "../../src/llm/errors.ts";
import { cleanupTempWorkspace, createTempWorkspace } from "../tools/test-helpers.ts";
import {
  createBus,
  FakeProvider,
  SESSION_A,
  RUN_A,
  collectEvents,
  textResponse,
  toolCall,
  toolResponse,
  type FakeTurn,
} from "./test-helpers.ts";

function makeContext(workspaceRoot: string, maxSteps?: number): ExecutionContext {
  return new ExecutionContext({
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceRoot,
    goal: "inspect the workspace",
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}

interface Harness {
  readonly bus: ReturnType<typeof createBus>;
  readonly provider: FakeProvider;
  readonly loop: AgentLoop;
}

function buildHarness(
  turns: readonly FakeTurn[],
  opts: ConstructorParameters<typeof AgentLoop>[4] = {},
): Harness {
  const bus = createBus();
  const provider = new FakeProvider(turns);
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    // builtinTools 为联合类型，注册时统一收敛为通用 Tool 契约。
    registry.register(tool as Tool);
  }
  const invoker = new ToolInvoker(registry, { retryDelaysMs: [0] });
  const loop = new AgentLoop(provider, registry, invoker, bus, opts);
  return { bus, provider, loop };
}

function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function stepsOf(events: readonly AgentEvent[], type: "step.started" | "step.finished"): number[] {
  return events.filter((e) => e.type === type).map((e) => (e.payload as { step: number }).step);
}

/** 安全取出第 index 次 LLM 调用的消息，缺失时直接失败。 */
function nthCallMessages(provider: FakeProvider, index: number) {
  const call = provider.calls[index];
  if (call === undefined) {
    throw new Error(`missing provider call at index ${index}`);
  }
  return call.messages;
}

async function runAndDrain(
  loop: AgentLoop,
  context: ExecutionContext,
  bus: ReturnType<typeof createBus>,
): Promise<{ events: AgentEvent[]; completion: RunCompletion }> {
  const { events, subscription } = await collectEvents(bus, context.sessionId, context.runId);
  const completion = await loop.run(context, new AbortController().signal);
  // AgentLoop 不再发布终态，因此等待已排队的非终态事件 drain 后主动释放订阅。
  await Bun.sleep(0);
  subscription.dispose();
  return { events, completion };
}

describe("AgentLoop", () => {
  test("publishes the configured context window with per-call usage", async () => {
    const workspace = await createTempWorkspace();
    try {
      const { bus, loop } = buildHarness(
        [
          {
            response: textResponse("done", {
              usage: {
                inputTokens: 159,
                outputTokens: 122,
                cacheReadInputTokens: 1152,
                cacheCreationInputTokens: 0,
              },
            }),
          },
        ],
        { contextWindowTokens: 200_000 },
      );
      const { events } = await runAndDrain(loop, makeContext(workspace), bus);
      const usageEvent = events.find((event) => event.type === "llm.usage");
      expect(usageEvent?.payload).toMatchObject({
        inputTokens: 159,
        cacheReadInputTokens: 1152,
        contextWindowTokens: 200_000,
      });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("completes a plain-text run and pairs every step.started with step.finished", async () => {
    const workspace = await createTempWorkspace();
    try {
      const { bus, provider, loop } = buildHarness([
        { deltas: ["Hello", " world"], response: textResponse("Hello world") },
      ]);
      const context = makeContext(workspace);
      const { events, completion } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("succeeded");
      expect(context.finalText).toBe("Hello world");
      expect(provider.calls).toHaveLength(1);

      const types = eventTypes(events);
      expect(types[0]).toBe("run.started");
      expect(types).toContain("llm.model_selected");
      expect(types).toContain("llm.text_delta");
      expect(types).toContain("llm.usage");
      expect(stepsOf(events, "step.started")).toEqual([1]);
      expect(stepsOf(events, "step.finished")).toEqual([1]);

      expect(events.some((event) => event.type === "run.finished")).toBe(false);
      expect(completion).toMatchObject({
        status: "succeeded",
        reason: "completed",
        finalText: "Hello world",
        steps: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("executes a single tool call and continues to completion", async () => {
    const workspace = await createTempWorkspace();
    try {
      await writeFile(join(workspace, "a.txt"), "AAA\n");
      const { bus, provider, loop } = buildHarness([
        { response: toolResponse([toolCall("c1", "read_file", { path: "a.txt" })]) },
        { response: textResponse("file read done") },
      ]);
      const context = makeContext(workspace);
      const { events } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("succeeded");
      expect(provider.calls).toHaveLength(2);

      // 第二步的模型输入应包含工具结果 observation。
      const secondCall = nthCallMessages(provider, 1);
      const toolResults = secondCall
        .flatMap((m) => m.content)
        .filter((p) => p.type === "tool_result");
      expect(toolResults).toHaveLength(1);
      const firstResult = toolResults[0];
      if (firstResult === undefined) {
        throw new Error("missing tool result");
      }
      expect(firstResult).toMatchObject({
        type: "tool_result",
        toolUseId: "c1",
        content: "AAA\n",
      });

      const toolFinished = events.find((e) => e.type === "tool.finished");
      expect(toolFinished?.payload).toMatchObject({
        toolCallId: "c1",
        name: "read_file",
        isError: false,
      });
      expect(stepsOf(events, "step.started")).toEqual([1, 2]);
      expect(stepsOf(events, "step.finished")).toEqual([1, 2]);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("executes multiple tool calls sequentially and merges results into one user message", async () => {
    const workspace = await createTempWorkspace();
    try {
      await writeFile(join(workspace, "a.txt"), "AAA\n");
      await writeFile(join(workspace, "b.txt"), "BBB\n");
      const { bus, provider, loop } = buildHarness([
        {
          response: toolResponse([
            toolCall("c1", "read_file", { path: "a.txt" }),
            toolCall("c2", "read_file", { path: "b.txt" }),
          ]),
        },
        { response: textResponse("both read") },
      ]);
      const context = makeContext(workspace);
      const { events } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("succeeded");

      const started = events
        .filter((e) => e.type === "tool.started")
        .map((e) => e.payload.toolCallId);
      expect(started).toEqual(["c1", "c2"]);

      const secondCall = nthCallMessages(provider, 1);
      const toolResults = secondCall
        .flatMap((m) => m.content)
        .filter((p) => p.type === "tool_result");
      expect(toolResults).toHaveLength(2);
      // 同一轮结果合并为一条 user message（除 goal 外仅新增一条 user 消息）。
      const toolResultMessages = secondCall.filter(
        (m) => m.role === "user" && m.content.some((p) => p.type === "tool_result"),
      );
      expect(toolResultMessages).toHaveLength(1);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("recovers from a failed tool call as an isError observation", async () => {
    const workspace = await createTempWorkspace();
    try {
      const { bus, provider, loop } = buildHarness([
        { response: toolResponse([toolCall("c1", "unknown_tool", {})]) },
        { response: textResponse("recovered") },
      ]);
      const context = makeContext(workspace);
      const { events } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("succeeded");

      const toolFinished = events.find((e) => e.type === "tool.finished");
      expect(toolFinished?.payload).toMatchObject({ toolCallId: "c1", isError: true });

      const secondCall = nthCallMessages(provider, 1);
      const toolResults = secondCall
        .flatMap((m) => m.content)
        .filter((p) => p.type === "tool_result");
      expect(toolResults).toHaveLength(1);
      const firstResult = toolResults[0];
      if (firstResult === undefined) {
        throw new Error("missing tool result");
      }
      expect(firstResult).toMatchObject({ type: "tool_result", isError: true });
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("fails with max_steps when the loop keeps requesting tools", async () => {
    const workspace = await createTempWorkspace();
    try {
      await writeFile(join(workspace, "a.txt"), "AAA\n");
      const { loop, bus } = buildHarness([
        { response: toolResponse([toolCall("c1", "read_file", { path: "a.txt" })]) },
      ]);
      const context = makeContext(workspace, 1);
      const { events, completion } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("failed");
      expect(context.reason).toBe("max_steps");

      expect(completion).toMatchObject({ status: "failed", reason: "max_steps", steps: 1 });
      expect(events.some((event) => event.type === "run.finished")).toBe(false);
      expect(stepsOf(events, "step.started")).toEqual([1]);
      expect(stepsOf(events, "step.finished")).toEqual([1]);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("rejects inconsistent finish reasons and tool calls", async () => {
    const workspace = await createTempWorkspace();
    try {
      for (const response of [
        { ...textResponse("done"), toolCalls: [toolCall("c1", "read_file", { path: "a.txt" })] },
        { ...toolResponse([]), toolCalls: [] },
      ]) {
        const { loop, bus } = buildHarness([{ response }]);
        const context = makeContext(workspace);
        await runAndDrain(loop, context, bus);
        expect(context.reason).toBe("invalid_llm_response");
      }
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("maps a config error into a failed run", async () => {
    const workspace = await createTempWorkspace();
    try {
      const { loop, bus } = buildHarness([{ error: new LlmError("config_error", "bad key") }]);
      const context = makeContext(workspace);
      const { events, completion } = await runAndDrain(loop, context, bus);

      expect(context.status).toBe("failed");
      expect(context.reason).toBe("config_error");

      expect(completion).toMatchObject({ status: "failed", reason: "config_error" });
      expect(events.some((event) => event.type === "run.finished")).toBe(false);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  test("cancels when the shared signal is aborted", async () => {
    const workspace = await createTempWorkspace();
    try {
      const { loop, bus } = buildHarness([{ response: textResponse("unused") }]);
      const context = makeContext(workspace);
      const { events, subscription } = await collectEvents(bus, context.sessionId, context.runId);

      const controller = new AbortController();
      controller.abort();
      const completion = await loop.run(context, controller.signal);
      await Bun.sleep(0);
      subscription.dispose();

      expect(context.status).toBe("cancelled");
      expect(completion).toMatchObject({ status: "cancelled", reason: "cancelled" });
      expect(events.some((event) => event.type === "run.finished")).toBe(false);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});
