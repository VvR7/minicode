import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { PermissionManager } from "../../src/permissions/manager.ts";
import { evaluatePermission, permissionSummary } from "../../src/permissions/policy.ts";
import { ToolInvoker } from "../../src/tools/invoker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WriteTool } from "../../src/tools/builtin/file-write.ts";
import {
  MemoryJournalStorage,
  SESSION_A,
  SESSION_B,
  RUN_A,
  RUN_B,
  finishedInput,
} from "../events/test-helpers.ts";

const scope = { sessionId: SESSION_A, runId: RUN_A, toolCallId: "call-1" };
const params = { path: "sample.txt", content: "hello" };

/** 组装内存事件存储并收集成功持久化的事件。 */
function setup() {
  const storage = new MemoryJournalStorage();
  const store = new EventStore("/memory", storage);
  const events: AgentEvent[] = [];
  const bus = new EventBus(store, { onPersisted: (event) => events.push(event) });
  return { storage, store, bus, events, manager: new PermissionManager(bus) };
}

/** 等待审批事件写入，返回 Core 生成的 ID。 */
async function requestId(events: AgentEvent[], count = 1): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const requested = events.filter((event) => event.type === "permission.requested");
    const event = requested[count - 1];
    if (event?.type === "permission.requested") return event.payload.permissionRequestId;
    await Bun.sleep(1);
  }
  throw new Error("approval not published");
}

describe("PermissionManager", () => {
  test("bypasspermission skips prompts but keeps forced policy decisions", async () => {
    const f = setup();
    const signal = new AbortController().signal;
    expect(
      await f.manager.check(
        "bash",
        { command: "echo allowed" },
        { ...scope, toolCallId: "bypass" },
        signal,
        "bypasspermission",
      ),
    ).toEqual({ allowed: true, source: "policy" });
    expect(
      await f.manager.check(
        "bash",
        { command: "git reset --hard" },
        { ...scope, toolCallId: "denied" },
        signal,
        "bypasspermission",
      ),
    ).toEqual({ allowed: false, source: "policy" });
    expect(f.events.some((event) => event.type === "permission.requested")).toBe(false);
  });

  test.each(["always_allow", "always_deny"] as const)(
    "%s caches only the same session and risk",
    async (decision) => {
      const { manager, events } = setup();
      const waiting = manager.check("write", params, scope, new AbortController().signal);
      const id = await requestId(events);
      expect(await manager.respond({ ...scope, permissionRequestId: id, decision })).toEqual({
        outcome: "accepted",
      });
      const allowed = decision === "always_allow";
      expect(await waiting).toEqual({ allowed, source: "user" });
      expect(
        await manager.check(
          "write",
          params,
          { ...scope, runId: RUN_B },
          new AbortController().signal,
        ),
      ).toEqual({ allowed, source: "session_cache" });
      const controller = new AbortController();
      const foreign = manager.check(
        "write",
        params,
        { ...scope, sessionId: SESSION_B },
        controller.signal,
      );
      await requestId(events, 2);
      controller.abort();
      await expect(foreign).rejects.toMatchObject({ code: "tool_cancelled" });
      const editController = new AbortController();
      const edit = manager.check(
        "edit",
        { path: "sample", oldText: "a", newText: "b" },
        scope,
        editController.signal,
      );
      await requestId(events, 3);
      editController.abort();
      await expect(edit).rejects.toMatchObject({ code: "tool_cancelled" });
      expect(manager.pendingCount).toBe(0);
    },
  );

  test("first valid response wins without leaking foreign or unknown requests", async () => {
    const { manager, events } = setup();
    const waiting = manager.check("write", params, scope, new AbortController().signal);
    const id = await requestId(events);
    const response = {
      sessionId: SESSION_A,
      runId: RUN_A,
      permissionRequestId: id,
      decision: "allow_once" as const,
    };
    expect(await manager.respond({ ...response, sessionId: SESSION_B })).toEqual({
      outcome: "not_found",
    });
    expect(await manager.respond({ ...response, runId: RUN_B })).toEqual({ outcome: "not_found" });
    expect(
      await manager.respond({ ...response, permissionRequestId: crypto.randomUUID() }),
    ).toEqual({ outcome: "not_found" });
    const [first, second] = await Promise.all([
      manager.respond(response),
      manager.respond({ ...response, decision: "deny_once" }),
    ]);
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("already_resolved");
    expect(await waiting).toEqual({ allowed: true, source: "user" });
    expect(await manager.respond(response)).toEqual({ outcome: "already_resolved" });
    expect(events.filter((event) => event.type === "permission.resolved")).toHaveLength(1);
  });

  test("safe allow and forced deny precede cached bash decisions", async () => {
    const { manager, events } = setup();
    const waiting = manager.check(
      "bash",
      { command: "rm sample" },
      scope,
      new AbortController().signal,
    );
    const id = await requestId(events);
    await manager.respond({ ...scope, permissionRequestId: id, decision: "always_allow" });
    await waiting;
    expect(
      await manager.check("bash", { command: "rm -rf /" }, scope, new AbortController().signal),
    ).toEqual({ allowed: false, source: "policy" });
    expect(
      await manager.check("bash", { command: "git status" }, scope, new AbortController().signal),
    ).toEqual({ allowed: true, source: "policy" });
    expect(
      await manager.check("read", { path: "/external" }, scope, new AbortController().signal),
    ).toEqual({ allowed: true, source: "policy" });
    expect(await manager.check("note_save", {}, scope, new AbortController().signal)).toEqual({
      allowed: true,
      source: "policy",
    });
    expect(events).toHaveLength(2);
  });

  test("composite commands reject always and never reuse single-risk cache", async () => {
    const { manager, events } = setup();
    const command = "mkdir a && mkdir b";
    const waiting = manager.check("bash", { command }, scope, new AbortController().signal);
    const id = await requestId(events);
    expect(events[0]).toMatchObject({ payload: { cacheable: false } });
    expect(
      await manager.respond({ ...scope, permissionRequestId: id, decision: "always_allow" }),
    ).toEqual({ outcome: "not_found" });
    expect(manager.pendingCount).toBe(1);
    await manager.respond({ ...scope, permissionRequestId: id, decision: "deny_once" });
    expect(await waiting).toEqual({ allowed: false, source: "user" });
    const controller = new AbortController();
    const next = manager.check("bash", { command }, scope, controller.signal);
    await requestId(events, 2);
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: "tool_cancelled" });
  });

  test.each(["cancel", "shutdown"])(
    "%s releases waiting without a fake user resolution",
    async (action) => {
      const { manager, events, bus } = setup();
      const controller = new AbortController();
      const waiting = manager.check("write", params, scope, controller.signal);
      const id = await requestId(events);
      if (action === "cancel") controller.abort();
      else manager.close();
      await expect(waiting).rejects.toMatchObject({ code: "tool_cancelled" });
      expect(manager.pendingCount).toBe(0);
      expect(
        await manager.respond({ ...scope, permissionRequestId: id, decision: "allow_once" }),
      ).toEqual({ outcome: "already_resolved" });
      await bus.publish(finishedInput());
      expect(events.map((event) => event.type)).toEqual(["permission.requested", "run.finished"]);
      if (action === "shutdown")
        await expect(
          manager.check("write", params, scope, new AbortController().signal),
        ).rejects.toMatchObject({ code: "tool_cancelled" });
    },
  );

  test("approval events replay durably; a fresh manager has no cached or pending requests", async () => {
    const { manager, events, store, bus } = setup();
    const waiting = manager.check("write", params, scope, new AbortController().signal);
    const id = await requestId(events);
    await manager.respond({ ...scope, permissionRequestId: id, decision: "always_allow" });
    await waiting;
    const replayed: AgentEvent[] = [];
    const freshBus = new EventBus(store);
    const subscribed = await freshBus.subscribe(SESSION_A, RUN_A, (event) => {
      replayed.push(event);
    });
    expect(subscribed.ok).toBe(true);
    await Bun.sleep(1);
    expect(replayed).toEqual(events);
    if (subscribed.ok) subscribed.value.dispose();
    const fresh = new PermissionManager(bus);
    expect(
      await fresh.respond({ ...scope, permissionRequestId: id, decision: "allow_once" }),
    ).toEqual({ outcome: "not_found" });
    const controller = new AbortController();
    const next = fresh.check("write", params, scope, controller.signal);
    await requestId(events, 2);
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: "tool_cancelled" });
  });

  test("schema validation happens before approval; denial has zero attempts and retries", async () => {
    const { manager, events } = setup();
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    const invoker = new ToolInvoker(registry, { permissions: manager, timeoutMs: 5 });
    const context = { workspaceRoot: "/unused", signal: new AbortController().signal };
    expect(
      await invoker.invoke("write", { path: 1 }, context, { permissionScope: scope }),
    ).toMatchObject({ attempts: 0, result: { failure: { category: "schema_error" } } });
    expect(events).toHaveLength(0);
    const waiting = invoker.invoke("write", params, context, { permissionScope: scope });
    const id = await requestId(events);
    await Bun.sleep(20); // 大于执行超时，审批仍然挂起且不启动写入。
    expect(manager.pendingCount).toBe(1);
    await manager.respond({ ...scope, permissionRequestId: id, decision: "deny_once" });
    expect(await waiting).toMatchObject({
      attempts: 0,
      retries: [],
      permissionSource: "user",
      result: { failure: { category: "permission_denied" } },
    });
  });

  test("persistence failure propagates as infrastructure error and clears pending state", async () => {
    const { manager, storage } = setup();
    storage.appendError = new Error("disk unavailable");
    await expect(
      manager.check("write", params, scope, new AbortController().signal),
    ).rejects.toThrow("permission request persistence failed");
    expect(manager.pendingCount).toBe(0);
  });

  test("resolution persistence failure never allows tool execution", async () => {
    const { manager, storage, events } = setup();
    const waiting = manager.check("write", params, scope, new AbortController().signal);
    const id = await requestId(events);
    storage.appendError = new Error("disk unavailable");
    const rejectedWaiting = waiting.catch((error: unknown) => error);
    await expect(
      manager.respond({ ...scope, permissionRequestId: id, decision: "allow_once" }),
    ).rejects.toThrow("permission resolution persistence failed");
    expect(await rejectedWaiting).toBeInstanceOf(Error);
    expect(manager.pendingCount).toBe(0);
  });
});

describe("permission policy summaries", () => {
  test("summaries bound content and expose default timeout", () => {
    expect(permissionSummary("write", { path: "a", content: "中".repeat(3000) })).toMatchObject({
      contentBytes: 9000,
      previewStart: "中".repeat(1024),
      previewEnd: "中".repeat(1024),
    });
    expect(
      permissionSummary("edit", {
        path: "a",
        oldText: "a".repeat(3000),
        newText: "b".repeat(3000),
        replaceAll: true,
      }),
    ).toMatchObject({
      oldTextPreview: "a".repeat(1024),
      newTextPreview: "b".repeat(1024),
      replaceAll: true,
    });
    expect(permissionSummary("bash", { command: "echo hi" })).toMatchObject({
      timeoutSeconds: 120,
    });
    expect(permissionSummary("bash", { command: "echo hi", timeout: 3 })).toMatchObject({
      timeoutSeconds: 3,
    });
    expect(evaluatePermission("edit", {})).toMatchObject({
      decision: "ask",
      riskCategories: ["edit"],
    });
  });
});
