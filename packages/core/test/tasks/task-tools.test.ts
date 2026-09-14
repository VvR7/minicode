import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { createTaskTools } from "../../src/tasks/tools.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { ToolExecutionContext } from "../../src/tools/types.ts";
import { MemoryJournalStorage } from "../events/test-helpers.ts";
import { RUN_A, SESSION_A } from "../session/test-helpers.ts";
import { createTaskManager } from "./test-helpers.ts";

function makeContext(): ToolExecutionContext {
  return { workspaceRoot: "/workspace", signal: new AbortController().signal };
}

function makeInvoker() {
  const { manager } = createTaskManager();
  const bus = new EventBus(new EventStore("/memory", new MemoryJournalStorage()));
  const tools = createTaskTools({ manager, bus, sessionId: SESSION_A, runId: RUN_A });
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return { invoker: new ToolInvoker(registry), bus, manager };
}

describe("task planning tools", () => {
  test("create/update/list/get operate the same run TaskManager via ToolInvoker", async () => {
    const { invoker } = makeInvoker();
    const context = makeContext();

    const created = await invoker.invoke(
      "task_create",
      { subject: "read files", description: "inspect the workspace" },
      context,
    );
    expect(created.result.isError).toBe(false);
    expect(JSON.parse(created.result.content)).toEqual({
      revision: 1,
      task: expect.objectContaining({ id: 1, status: "pending" }),
    });

    const updated = await invoker.invoke("task_update", { id: 1, status: "in_progress" }, context);
    expect(updated.result.isError).toBe(false);
    expect(JSON.parse(updated.result.content).task.status).toBe("in_progress");

    const listed = await invoker.invoke("task_list", {}, context);
    expect(JSON.parse(listed.result.content).tasks).toHaveLength(1);

    const fetched = await invoker.invoke("task_get", { id: 1 }, context);
    expect(JSON.parse(fetched.result.content).task.id).toBe(1);
  });

  test("publishes task.created and task.updated with the committed revision", async () => {
    const { invoker, bus } = makeInvoker();
    const context = makeContext();
    const seen: AgentEvent[] = [];
    await bus.subscribe(SESSION_A, RUN_A, (event) => {
      seen.push(event);
    });

    await invoker.invoke("task_create", { subject: "a", description: "b" }, context);
    await invoker.invoke("task_update", { id: 1, status: "completed" }, context);
    // 等待订阅 drain 送达事件。
    await Bun.sleep(5);

    const created = seen.find((event) => event.type === "task.created");
    const updated = seen.find((event) => event.type === "task.updated");
    expect(created?.payload).toEqual({
      revision: 1,
      task: expect.objectContaining({ id: 1, status: "pending" }),
    });
    expect(updated?.payload).toEqual({
      revision: 2,
      task: expect.objectContaining({ id: 1, status: "completed" }),
    });
  });

  test("list and get are read-only and publish no task events", async () => {
    const { invoker, bus } = makeInvoker();
    const context = makeContext();
    const seen: AgentEvent[] = [];
    await bus.subscribe(SESSION_A, RUN_A, (event) => {
      seen.push(event);
    });
    await invoker.invoke("task_create", { subject: "a", description: "b" }, context);
    seen.length = 0;
    await invoker.invoke("task_list", {}, context);
    await invoker.invoke("task_get", { id: 1 }, context);
    await Bun.sleep(5);
    expect(seen.filter((event) => event.type.startsWith("task."))).toHaveLength(0);
  });

  test("surfaces domain errors as isError ToolResult without throwing", async () => {
    const { invoker } = makeInvoker();
    const context = makeContext();

    const invalid = await invoker.invoke("task_create", { subject: "", description: "x" }, context);
    expect(invalid.result.isError).toBe(true);

    const missing = await invoker.invoke("task_update", { id: 99, status: "in_progress" }, context);
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content).toContain("task_not_found");

    await invoker.invoke("task_create", { subject: "a", description: "b" }, context);
    await invoker.invoke("task_update", { id: 1, status: "completed" }, context);
    const immutable = await invoker.invoke("task_update", { id: 1, subject: "renamed" }, context);
    expect(immutable.result.isError).toBe(true);
    expect(immutable.result.content).toContain("immutable_task");
  });

  test("store failures surface as isError ToolResult across create/list/get", async () => {
    const { manager, storage } = createTaskManager();
    const bus = new EventBus(new EventStore("/memory", new MemoryJournalStorage()));
    const tools = createTaskTools({ manager, bus, sessionId: SESSION_A, runId: RUN_A });
    const registry = new ToolRegistry();
    for (const tool of tools) {
      registry.register(tool);
    }
    const invoker = new ToolInvoker(registry);
    const context = makeContext();

    storage.files.set("/home/sessions/a/runs/b/tasks.json", "not json");
    const created = await invoker.invoke(
      "task_create",
      { subject: "a", description: "b" },
      context,
    );
    expect(created.result.isError).toBe(true);
    expect(created.result.content).toContain("task_store_corrupted");

    const listed = await invoker.invoke("task_list", {}, context);
    expect(listed.result.isError).toBe(true);

    const fetched = await invoker.invoke("task_get", { id: 1 }, context);
    expect(fetched.result.isError).toBe(true);
  });
});
