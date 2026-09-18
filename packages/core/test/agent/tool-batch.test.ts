import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { z } from "zod";
import { ExecutionContext } from "../../src/agent/context.ts";
import { AgentLoop } from "../../src/agent/loop.ts";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { PermissionManager } from "../../src/permissions/manager.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolError, type Tool, type ToolOutput } from "../../src/tools/types.ts";
import type { LlmToolCall } from "../../src/llm/types.ts";
import {
  FakeProvider,
  MemoryJournalStorage,
  RUN_A,
  SESSION_A,
  textResponse,
  toolCall,
  toolResponse,
} from "./test-helpers.ts";

/** 使用内存事件和可编程模型验证批次，不依赖真实文件或网络。 */
function harness(
  tools: readonly Tool[],
  calls: LlmToolCall[],
  onEvent?: (event: AgentEvent) => void,
  storage = new MemoryJournalStorage(),
) {
  const events: AgentEvent[] = [];
  const bus = new EventBus(new EventStore("/unused", storage), {
    onPersisted(event) {
      events.push(event);
      onEvent?.(event);
    },
  });
  const permissions = new PermissionManager(bus);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const invoker = new ToolInvoker(registry, { permissions, retryDelaysMs: [0] });
  const provider = new FakeProvider([
    { response: toolResponse(calls) },
    { response: textResponse("done") },
  ]);
  const loop = new AgentLoop(provider, registry, invoker, bus);
  const context = new ExecutionContext({
    sessionId: SESSION_A,
    runId: RUN_A,
    workspaceRoot: "/workspace",
    goal: "run tools",
  });
  return { loop, context, provider, events, permissions, invoker };
}

/** 创建无参数工具；模式省略时应并行。 */
function tool(name: string, execute: Tool["execute"], executeMode?: Tool["executeMode"]): Tool {
  return {
    name,
    description: name,
    inputSchema: z.strictObject({}),
    execute,
    ...(executeMode === undefined ? {} : { executeMode }),
  };
}

/** 取第二步模型收到的配对结果，验证回填顺序而非完成顺序。 */
function observations(provider: FakeProvider) {
  return provider.calls[1]?.messages.flatMap((message) =>
    message.content.filter((part) => part.type === "tool_result"),
  );
}

describe("AgentLoop tool batches", () => {
  test("default-parallel tools overlap, finish out of order, and return results in request order", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstOutput = Promise.withResolvers<ToolOutput>();
    const secondOutput = Promise.withResolvers<ToolOutput>();
    const secondFinished = Promise.withResolvers<void>();
    const h = harness(
      [
        tool("first", () => {
          firstStarted.resolve();
          return firstOutput.promise;
        }),
        tool("second", () => {
          secondStarted.resolve();
          return secondOutput.promise;
        }),
      ],
      [toolCall("1", "first"), toolCall("2", "second")],
      (event) => {
        if (event.type === "tool.finished" && event.payload.toolCallId === "2")
          secondFinished.resolve();
      },
    );
    const running = h.loop.run(h.context, new AbortController().signal);
    // 两者都已开始而第一个尚未结束，直接证明执行重叠。
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    secondOutput.resolve({ content: "second result" });
    await secondFinished.promise;
    firstOutput.resolve({ content: "first result" });
    expect((await running).status).toBe("succeeded");
    expect(
      h.events.filter((e) => e.type === "tool.finished").map((e) => e.payload.toolCallId),
    ).toEqual(["2", "1"]);
    expect(observations(h.provider)?.map((part) => part.toolUseId)).toEqual(["1", "2"]);
    expect(observations(h.provider)?.map((part) => part.content)).toEqual([
      "first result",
      "second result",
    ]);
  });

  test("one serial tool makes the entire batch alternate preparation and execution", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstOutput = Promise.withResolvers<ToolOutput>();
    const order: string[] = [];
    const h = harness(
      [
        tool("first", () => {
          order.push("execute:first");
          firstStarted.resolve();
          return firstOutput.promise;
        }),
        tool(
          "second",
          () => {
            order.push("execute:second");
            return { content: "ok" };
          },
          "serial",
        ),
      ],
      [toolCall("1", "first"), toolCall("2", "second")],
    );
    h.permissions.check = async (name) => {
      order.push(`check:${name}`);
      return { allowed: true, source: "policy" };
    };
    const running = h.loop.run(h.context, new AbortController().signal);
    await firstStarted.promise;
    expect(order).toEqual(["check:first", "execute:first"]);
    firstOutput.resolve({ content: "ok" });
    expect((await running).status).toBe("succeeded");
    expect(order).toEqual(["check:first", "execute:first", "check:second", "execute:second"]);
  });

  test("parallel execution waits for all ordered approvals and denial remains an independent result", async () => {
    const firstCheck = Promise.withResolvers<void>();
    const secondCheck = Promise.withResolvers<void>();
    const allowFirst = Promise.withResolvers<void>();
    const denySecond = Promise.withResolvers<void>();
    const order: string[] = [];
    const h = harness(
      [
        tool("first", () => {
          order.push("execute:first");
          return { content: "ok" };
        }),
        tool("second", () => {
          order.push("execute:second");
          return { content: "unexpected" };
        }),
      ],
      [toolCall("1", "first"), toolCall("2", "second")],
    );
    h.permissions.check = async (name) => {
      order.push(`check:${name}`);
      if (name === "first") {
        firstCheck.resolve();
        await allowFirst.promise;
      } else {
        secondCheck.resolve();
        await denySecond.promise;
      }
      return { allowed: name === "first", source: "user" };
    };
    const running = h.loop.run(h.context, new AbortController().signal);
    await firstCheck.promise;
    expect(order).toEqual(["check:first"]);
    allowFirst.resolve();
    await secondCheck.promise;
    expect(order).toEqual(["check:first", "check:second"]);
    denySecond.resolve();
    expect((await running).status).toBe("succeeded");
    expect(order).toEqual(["check:first", "check:second", "execute:first"]);
    expect(observations(h.provider)?.[1]).toMatchObject({
      toolUseId: "2",
      isError: true,
      content: "tool permission denied",
    });
  });

  test("schema, unknown-tool and runtime failures do not discard successful siblings", async () => {
    let invalidExecuted = false;
    const invalid: Tool = {
      ...tool("invalid", () => {
        invalidExecuted = true;
        return { content: "unexpected" };
      }),
      inputSchema: z.strictObject({ required: z.string() }),
    };
    const h = harness(
      [
        invalid,
        tool("broken", () => {
          throw new ToolError("not_found", "missing resource");
        }),
        tool("ok", () => ({ content: "success" })),
      ],
      [
        toolCall("1", "invalid"),
        toolCall("2", "unknown"),
        toolCall("3", "broken"),
        toolCall("4", "ok"),
      ],
    );
    expect((await h.loop.run(h.context, new AbortController().signal)).status).toBe("succeeded");
    expect(invalidExecuted).toBe(false);
    expect(observations(h.provider)?.map((part) => part.toolUseId)).toEqual(["1", "2", "3", "4"]);
    expect(observations(h.provider)?.map((part) => part.isError ?? false)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("cancellation during preparation prevents every approved tool from starting", async () => {
    const secondCheck = Promise.withResolvers<void>();
    const controller = new AbortController();
    let executions = 0;
    const h = harness(
      [
        tool("first", () => {
          executions += 1;
          return { content: "ok" };
        }),
      ],
      [toolCall("1", "first"), toolCall("2", "first")],
    );
    let checks = 0;
    h.permissions.check = async (_name, _params, _scope, signal) => {
      if (++checks === 2) {
        secondCheck.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return { allowed: true, source: "policy" };
    };
    const running = h.loop.run(h.context, controller.signal);
    await secondCheck.promise;
    controller.abort();
    expect((await running).status).toBe("cancelled");
    expect(executions).toBe(0);
  });

  test("external cancellation reaches every running sibling and prevents a further model call", async () => {
    const bothStarted = Promise.withResolvers<void>();
    const controller = new AbortController();
    let started = 0;
    let cleaned = 0;
    const waiting = tool("waiting", (_params, context) => {
      if (++started === 2) bothStarted.resolve();
      return new Promise((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            cleaned += 1;
            resolve({ content: "cancelled" });
          },
          { once: true },
        );
      });
    });
    const h = harness([waiting], [toolCall("1", "waiting"), toolCall("2", "waiting")]);
    const running = h.loop.run(h.context, controller.signal);
    await bothStarted.promise;
    controller.abort();
    expect((await running).status).toBe("cancelled");
    expect(cleaned).toBe(2);
    expect(h.provider.calls).toHaveLength(1);
  });

  test("infrastructure failure cancels and drains running siblings before returning the failure", async () => {
    const storage = new MemoryJournalStorage();
    const originalAppend = storage.append.bind(storage);
    storage.append = async (path, content) => {
      if (content.includes('"type":"tool.finished"') && content.includes('"toolCallId":"1"'))
        throw new Error("journal unavailable");
      await originalAppend(path, content);
    };
    let siblingStarted = false;
    let siblingCleaned = false;
    const h = harness(
      [
        tool("first", () => ({ content: "ok" })),
        tool("second", (_params, context) => {
          siblingStarted = true;
          return new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                siblingCleaned = true;
                resolve({ content: "cancelled" });
              },
              { once: true },
            );
          });
        }),
      ],
      [toolCall("1", "first"), toolCall("2", "second")],
      undefined,
      storage,
    );
    const result = await h.loop.run(h.context, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", reason: "event_store_error" });
    expect(siblingStarted).toBe(true);
    expect(siblingCleaned).toBe(true);
    expect(h.provider.calls).toHaveLength(1);
  });
});
