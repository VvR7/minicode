import { expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { McpTool, mcpOutput, workspaceMcpTools } from "../../src/mcp/tool.ts";
import type { ConnectedMcpServer } from "../../src/mcp/server-manager.ts";
import { PermissionManager } from "../../src/permissions/manager.ts";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { MemoryJournalStorage, SESSION_A, RUN_A } from "../events/test-helpers.ts";
const schema = {
  type: "object" as const,
  properties: { value: { type: "integer", minimum: 1 } },
  required: ["value"],
  additionalProperties: false,
};
const scope = { sessionId: SESSION_A, runId: RUN_A, toolCallId: "call" };
/** 使用真实审批总线和可观测 SDK 门面组装工具。 */
function fixture(
  call: ConnectedMcpServer["client"]["callTool"] = async () => ({
    content: [{ type: "text", text: "ok" }],
  }),
) {
  const events: AgentEvent[] = [];
  const store = new EventStore("/memory", new MemoryJournalStorage());
  const bus = new EventBus(store, {
    onPersisted: (event) => events.push(event),
  });
  const permissions = new PermissionManager(bus);
  let calls = 0;
  const server: ConnectedMcpServer = {
    name: "demo",
    executeMode: "parallel",
    tools: [
      { name: "first", inputSchema: schema },
      { name: "second", inputSchema: schema },
    ],
    client: {
      async connect() {},
      async listTools() {
        return [];
      },
      async close() {},
      async callTool(...args) {
        calls++;
        return call(...args);
      },
    },
  };
  const registry = new ToolRegistry();
  const tools = workspaceMcpTools({ servers: [server], diagnostics: [] });
  for (const tool of tools) registry.register(tool);
  return {
    events,
    store,
    permissions,
    server,
    registry,
    tools,
    calls: () => calls,
    invoker: new ToolInvoker(registry, { permissions, timeoutMs: 20 }),
  };
}
/** 等待实际持久化审批，避免固定时延依赖。 */
async function requested(events: AgentEvent[], count: number) {
  for (let i = 0; i < 100; i++) {
    const event = events.filter((e) => e.type === "permission.requested")[count - 1];
    if (event?.type === "permission.requested") return event;
    await Bun.sleep(1);
  }
  throw new Error("approval missing");
}
const context = () => ({ workspaceRoot: "/memory", signal: new AbortController().signal });

test("JSON Schema validates before approval, denied calls never send, always cache uses full tool name", async () => {
  const f = fixture();
  for (const params of [{ value: 0 }, { value: "1" }, { value: 1, extra: true }, {}]) {
    const result = await f.invoker.invoke("mcp__demo__first", params, context(), {
      permissionScope: scope,
    });
    expect(result.result.failure?.category).toBe("schema_error");
  }
  expect(f.events).toHaveLength(0);
  expect(f.calls()).toBe(0);
  const first = f.invoker.invoke("mcp__demo__first", { value: 1 }, context(), {
    permissionScope: scope,
  });
  const event = await requested(f.events, 1);
  await f.permissions.respond({
    ...scope,
    permissionRequestId: event.payload.permissionRequestId,
    decision: "always_allow",
  });
  expect((await first).result.isError).toBe(false);
  expect(
    (
      await f.invoker.invoke("mcp__demo__first", { value: 2 }, context(), {
        permissionScope: scope,
      })
    ).permissionSource,
  ).toBe("session_cache");
  const second = f.invoker.invoke("mcp__demo__second", { value: 1 }, context(), {
    permissionScope: scope,
  });
  const other = await requested(f.events, 2);
  await f.permissions.respond({
    ...scope,
    permissionRequestId: other.payload.permissionRequestId,
    decision: "always_deny",
  });
  expect((await second).result.failure?.category).toBe("permission_denied");
  expect(f.calls()).toBe(2);
  expect(f.registry.toolSchemas()[0]?.inputSchema).toEqual(schema);
});

test("approval summaries redact credentials, remain bounded, and durable replay preserves them", async () => {
  const f = fixture();
  const controller = new AbortController();
  const check = f.permissions.check(
    "mcp__demo__first",
    { apiKey: "secret-value", query: "x".repeat(2000), nested: { authorization: "Bearer secret" } },
    scope,
    controller.signal,
  );
  const event = await requested(f.events, 1);
  expect(event.payload.summary.kind).toBe("mcp");
  expect(JSON.stringify(event)).not.toContain("secret-value");
  if (event.payload.summary.kind === "mcp")
    expect(event.payload.summary.paramsPreview.length).toBeLessThanOrEqual(1024);
  const replayed: AgentEvent[] = [];
  const subscribed = await new EventBus(f.store).subscribe(SESSION_A, RUN_A, (event) => {
    replayed.push(event);
  });
  await Bun.sleep(1);
  expect(replayed).toEqual(f.events);
  if (subscribed.ok) subscribed.value.dispose();
  controller.abort();
  await expect(check).rejects.toMatchObject({ code: "tool_cancelled" });
});

test("MCP result keeps text and structured content but omits binary blocks", () => {
  const output = mcpOutput({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "BASE64_SECRET", mimeType: "image/png" },
      { type: "audio", data: "AUDIO_SECRET", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: {
          uri: "file:///sample",
          blob: "BLOB_SECRET",
          mimeType: "application/octet-stream",
        },
      },
      { type: "resource_link", uri: "file:///link", name: "link" },
    ],
    structuredContent: { count: 3 },
  });
  expect(output.content).toContain("hello");
  expect(output.content).toContain('{"count":3}');
  expect(output.content).toContain("file:///sample");
  expect(output.content).toContain("file:///link");
  expect(output.content).not.toContain("SECRET");
});

test.each([true, false])("server error and request failure do not retry (%s)", async (isError) => {
  const f = fixture(async () => {
    if (!isError) throw new Error("credential-secret");
    return { content: [{ type: "text", text: "server failure" }], isError: true };
  });
  const invoker = new ToolInvoker(f.registry);
  const result = await invoker.invoke("mcp__demo__first", { value: 1 }, context());
  expect(result.attempts).toBe(1);
  expect(result.result.isError).toBe(true);
  expect(result.result.content).not.toContain("credential-secret");
  if (isError) expect(result.result.content).toBe("server failure");
  expect(f.calls()).toBe(1);
});

test("timeout and external cancellation propagate to the client", async () => {
  const signals: AbortSignal[] = [];
  const f = fixture(async (_name, _args, signal) => {
    signals.push(signal);
    return new Promise<CallToolResult>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
  });
  const invoker = new ToolInvoker(f.registry, { timeoutMs: 5 });
  expect(
    (await invoker.invoke("mcp__demo__first", { value: 1 }, context())).result.failure?.category,
  ).toBe("timeout");
  const controller = new AbortController();
  const pending = invoker.invoke(
    "mcp__demo__first",
    { value: 1 },
    { workspaceRoot: "/memory", signal: controller.signal },
  );
  await Bun.sleep(1);
  controller.abort();
  expect((await pending).result.failure?.category).toBe("cancelled");
  expect(signals.every((s) => s.aborted)).toBe(true);
});

test("concurrent calls stay associated and collision rejects overwrite", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (_name, args) => {
    await barrier;
    return { content: [{ type: "text", text: String(Object.values(args)[0]) }] };
  });
  const invoker = new ToolInvoker(f.registry);
  const one = invoker.invoke("mcp__demo__first", { value: 1 }, context());
  const two = invoker.invoke("mcp__demo__first", { value: 2 }, context());
  await Bun.sleep(1);
  expect(f.calls()).toBe(2);
  release();
  expect((await Promise.all([one, two])).map((r) => r.result.content)).toEqual(["1", "2"]);
  expect(() => workspaceMcpTools({ servers: [f.server, f.server], diagnostics: [] })).toThrow(
    "collision",
  );
  const definition = f.server.tools[0];
  if (!definition) throw new Error("fixture tool missing");
  expect(() => f.registry.register(new McpTool(f.server, definition))).toThrow("duplicate");
  expect(new McpTool({ ...f.server, executeMode: "serial" }, definition).executeMode).toBe(
    "serial",
  );
});

test.each([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
])("JSON Schema draft and format validation (%s)", (draft) => {
  const f = fixture();
  const tool = new McpTool(f.server, {
    name: "typed",
    inputSchema: {
      $schema: draft,
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    },
  });
  expect(tool.inputSchema.safeParse({ email: "invalid" }).success).toBe(false);
  expect(tool.inputSchema.safeParse({ email: "test@example.com" }).success).toBe(true);
});
