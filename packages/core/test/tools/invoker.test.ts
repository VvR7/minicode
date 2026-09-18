import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolError, type Tool, type ToolExecutionContext } from "../../src/tools/types.ts";

function context(signal?: AbortSignal): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp/workspace",
    signal: signal ?? new AbortController().signal,
  };
}

function invokerWith(tool: Tool, options: ConstructorParameters<typeof ToolInvoker>[1] = {}) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new ToolInvoker(registry, options);
}

describe("ToolInvoker parameter handling", () => {
  test("returns unknown_tool for unregistered tools", async () => {
    const invoker = new ToolInvoker(new ToolRegistry());
    const result = await invoker.invoke("nope", {}, context());
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("unknown tool: nope");
    expect(result.result.failure).toEqual({ category: "schema_error", errorCode: "unknown_tool" });
    expect(result.attempts).toBe(0);
  });

  test("rejects invalid params without executing the tool", async () => {
    let called = false;
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({ path: z.string() }),
      execute: () => {
        called = true;
        return { content: "ok" };
      },
    };
    const invoker = invokerWith(tool);
    const result = await invoker.invoke("t", { wrong: true }, context());
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("invalid tool parameters");
    expect(called).toBe(false);
  });

  test("returns a successful result with byte accounting", async () => {
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => ({ content: "hello" }),
    };
    const result = await invokerWith(tool).invoke("t", {}, context());
    expect(result.result).toEqual({
      content: "hello",
      isError: false,
      truncated: false,
      outputBytes: 5,
    });
  });
});

describe("ToolInvoker retry", () => {
  test("publishes retry before the next attempt and supports cancellation during backoff", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const tool: Tool = {
      name: "flaky",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        order.push("execute");
        throw new ToolError("temporary_io_error", "temporary", { retryable: true });
      },
    };
    const result = await invokerWith(tool, { retryDelaysMs: [1_000] }).invoke(
      "flaky",
      {},
      context(controller.signal),
      {
        onRetry: (retry) => {
          order.push(`retry-${retry.attempt}`);
          controller.abort();
        },
      },
    );
    expect(order).toEqual(["execute", "retry-2"]);
    expect(result.attempts).toBe(1);
    expect(result.result.failure).toEqual({ category: "cancelled", errorCode: "tool_cancelled" });
  });

  test("retries safe-to-retry errors up to max attempts", async () => {
    let calls = 0;
    const tool: Tool = {
      name: "flaky",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        calls += 1;
        if (calls === 1) {
          throw new ToolError("io_error", "transient", true);
        }
        return { content: "ok" };
      },
    };
    const result = await invokerWith(tool, { retryDelaysMs: [0] }).invoke("flaky", {}, context());
    expect(result.result.isError).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.retries).toEqual([
      {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        errorCode: "io_error",
        failureCategory: "runtime_error",
      },
    ]);
  });

  test("retries rate limits but never retries forbidden failure categories", async () => {
    let rateCalls = 0;
    const rateLimited: Tool = {
      name: "rate",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        rateCalls += 1;
        if (rateCalls === 1) throw new ToolError("rate_limited", "slow down");
        return { content: "ok" };
      },
    };
    const rateResult = await invokerWith(rateLimited, { retryDelaysMs: [0] }).invoke(
      "rate",
      {},
      context(),
    );
    expect(rateResult.attempts).toBe(2);
    expect(rateResult.retries[0]).toMatchObject({ failureCategory: "rate_limited" });

    let deniedCalls = 0;
    const denied: Tool = {
      name: "denied",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        deniedCalls += 1;
        throw new ToolError("permission_denied", "denied", { retryable: true });
      },
    };
    await invokerWith(denied, { retryDelaysMs: [0] }).invoke("denied", {}, context());
    expect(deniedCalls).toBe(1);
  });

  test("does not retry non-retryable errors", async () => {
    let calls = 0;
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        calls += 1;
        throw new ToolError("not_found", "file not found");
      },
    };
    const result = await invokerWith(tool, { retryDelaysMs: [0] }).invoke("t", {}, context());
    expect(calls).toBe(1);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("file not found");
    expect(result.retries).toEqual([]);
  });

  test("does not retry an unknown exception", async () => {
    let calls = 0;
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        calls += 1;
        throw new Error("unexpected");
      },
    };
    await invokerWith(tool, { retryDelaysMs: [0] }).invoke("t", {}, context());
    expect(calls).toBe(1);
  });

  test("surfaces the last error after exhausting retries", async () => {
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        throw new ToolError("io_error", "still broken", true);
      },
    };
    const result = await invokerWith(tool, { retryDelaysMs: [0] }).invoke("t", {}, context());
    expect(result.attempts).toBe(3);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("still broken");
    expect(result.retries).toEqual([
      {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        errorCode: "io_error",
        failureCategory: "runtime_error",
      },
      {
        attempt: 3,
        maxAttempts: 3,
        delayMs: 0,
        errorCode: "io_error",
        failureCategory: "runtime_error",
      },
    ]);
  });
});

describe("ToolInvoker timeout and abort", () => {
  test("explicit null timeout creates no timer but still responds to external cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const tool: Tool = {
      name: "wait",
      description: "",
      inputSchema: z.strictObject({}),
      timeoutMs: () => null,
      execute: () => {
        started.resolve();
        return new Promise(() => {});
      },
    };
    const controller = new AbortController();
    const timerSpy = spyOn(globalThis, "setTimeout");
    try {
      const pending = invokerWith(tool, { timeoutMs: 1 }).invoke(
        "wait",
        {},
        context(controller.signal),
      );
      await started.promise;
      expect(timerSpy).not.toHaveBeenCalled();
      controller.abort();
      const result = await pending;
      expect(result.result.failure).toEqual({ category: "cancelled", errorCode: "tool_cancelled" });
      expect(result.attempts).toBe(1);
    } finally {
      controller.abort();
      timerSpy.mockRestore();
    }
  });

  test("times out a hanging tool", async () => {
    const tool: Tool = {
      name: "slow",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => new Promise(() => {}),
    };
    const result = await invokerWith(tool, { timeoutMs: 20 }).invoke("slow", {}, context());
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("tool call timed out");
    expect(result.result.failure).toEqual({ category: "timeout", errorCode: "tool_timeout" });
  });

  test("aborts when the caller cancels", async () => {
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => new Promise(() => {}),
    };
    const controller = new AbortController();
    const pending = invokerWith(tool).invoke("t", {}, context(controller.signal));
    controller.abort();
    const result = await pending;
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("tool call cancelled");
  });

  test("does not execute a tool when the caller is already cancelled", async () => {
    let calls = 0;
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => {
        calls += 1;
        return { content: "unexpected" };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await invokerWith(tool).invoke("t", {}, context(controller.signal));
    expect(calls).toBe(0);
    expect(result.result.content).toBe("tool call cancelled");
  });
});

describe("ToolInvoker truncation", () => {
  test("truncates oversized results to 256 KiB", async () => {
    const tool: Tool = {
      name: "big",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => ({ content: "a".repeat(300 * 1024) }),
    };
    const result = await invokerWith(tool).invoke("big", {}, context());
    expect(result.result.truncated).toBe(true);
    expect(result.result.outputBytes).toBe(300 * 1024);
    expect(new TextEncoder().encode(result.result.content).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
  });

  test("preserves tool-provided truncation metadata", async () => {
    const tool: Tool = {
      name: "t",
      description: "",
      inputSchema: z.strictObject({}),
      execute: () => ({ content: "short", truncated: true, outputBytes: 999 }),
    };
    const result = await invokerWith(tool).invoke("t", {}, context());
    expect(result.result).toEqual({
      content: "short",
      isError: false,
      truncated: true,
      outputBytes: 999,
    });
  });
});
