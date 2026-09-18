import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool } from "../../src/tools/types.ts";

const dummyTool: Tool<{ x: string }> = {
  name: "dummy",
  description: "a dummy tool",
  inputSchema: z.strictObject({ x: z.string() }),
  execute: () => ({ content: "ok" }),
};

describe("ToolRegistry", () => {
  test("registers and retrieves tools", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);
    expect(registry.get("dummy")).toBe(dummyTool);
    expect(registry.size).toBe(1);
  });

  test("rejects duplicate tool names at registration time", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);
    expect(() => registry.register(dummyTool)).toThrow("duplicate tool registration: dummy");
  });

  test("exports LLM JSON schemas from Zod input schemas", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);
    expect(registry.toolSchemas()).toEqual([
      {
        name: "dummy",
        description: "a dummy tool",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { x: { type: "string" } },
          additionalProperties: false,
        }),
      },
    ]);
  });

  test("returns undefined for unknown tools", () => {
    expect(new ToolRegistry().get("missing")).toBeUndefined();
  });

  test("preserves an external JSON schema while retaining the local Zod validator", () => {
    const registry = new ToolRegistry();
    const originalSchema = {
      type: "object",
      properties: { x: { type: "string", minLength: 3 } },
      required: ["x"],
      additionalProperties: false,
    };
    registry.register({
      ...dummyTool,
      executeMode: "serial",
      llmInputSchema: originalSchema,
      inputSchema: z.strictObject({ x: z.string().min(3) }),
    });
    expect(registry.toolSchemas()[0]?.inputSchema).toEqual(originalSchema);
    expect(registry.get("dummy")?.inputSchema.safeParse({ x: "no" }).success).toBe(false);
    expect(registry.get("dummy")?.executeMode).toBe("serial");
    // 普通工具不需要声明模式，调度层将省略值按 parallel 处理。
    const defaults = new ToolRegistry();
    defaults.register(dummyTool);
    expect(defaults.get("dummy")?.executeMode).toBeUndefined();
  });
});
