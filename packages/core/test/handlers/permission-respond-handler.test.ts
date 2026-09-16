import { expect, test } from "bun:test";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { IpcEventBroadcaster } from "../../src/events/ipc-event-broadcaster.ts";
import { IpcSessionBroadcaster } from "../../src/events/ipc-session-broadcaster.ts";
import { SessionEventBus } from "../../src/events/session-event-bus.ts";
import { PermissionRespondHandler } from "../../src/handlers/permission-respond-handler.ts";
import { PermissionManager } from "../../src/permissions/manager.ts";
import type { RpcInvocationContext } from "../../src/rpc-context.ts";
import {
  MemoryJournalStorage,
  SESSION_A,
  SESSION_B,
  RUN_A,
  RUN_B,
} from "../events/test-helpers.ts";
import { createMemoryStore, seedSession } from "../session/test-helpers.ts";

/** 提供可关闭的测试连接，避免 transport 参与 handler 单测。 */
function context(id: string) {
  const closed = Promise.withResolvers<void>();
  return {
    connection: {
      id,
      closed: closed.promise,
      sendNotification: async () => true,
      disconnect: () => closed.resolve(),
    },
    close: () => closed.resolve(),
  };
}

test("permission RPC validates params and accepts only current run or session attachments", async () => {
  const bus = new EventBus(new EventStore("/memory", new MemoryJournalStorage()));
  const run = new IpcEventBroadcaster(bus);
  const { store, storage } = createMemoryStore("/session");
  seedSession(storage, "/session", SESSION_A);
  seedSession(storage, "/session", SESSION_B);
  const session = new IpcSessionBroadcaster(new SessionEventBus(store));
  const permissions = new PermissionManager(bus);
  const handler = new PermissionRespondHandler(
    permissions,
    (ctx: RpcInvocationContext, params) =>
      run.isAttached(ctx.connection, params.sessionId, params.runId) ||
      session.isAttached(ctx.connection, params.sessionId),
  );
  const owner = context("owner");
  const foreign = context("foreign");
  const params = {
    sessionId: SESSION_A,
    runId: RUN_A,
    permissionRequestId: crypto.randomUUID(),
    decision: "allow_once",
  };
  expect(await handler.invoke({ ...params, decision: "allow" }, owner)).toEqual({
    kind: "invalid-params",
  });
  expect(await handler.invoke({ ...params, extra: 1 }, owner)).toEqual({ kind: "invalid-params" });
  expect(await handler.invoke(params, owner)).toEqual({
    kind: "success",
    result: { outcome: "not_found" },
  });

  const subscribed = await run.subscribe(owner.connection, SESSION_A, RUN_A);
  expect(subscribed.ok).toBe(true);
  expect(run.isAttached(owner.connection, SESSION_A, RUN_A)).toBe(true);
  expect(run.isAttached(owner.connection, SESSION_A, RUN_B)).toBe(false);
  expect(run.isAttached(foreign.connection, SESSION_A, RUN_A)).toBe(false);
  expect(await handler.invoke(params, owner)).toEqual({
    kind: "success",
    result: { outcome: "not_found" },
  });
  if (subscribed.ok) run.unsubscribe(owner.connection, subscribed.value.result.subscriptionId);
  expect(run.isAttached(owner.connection, SESSION_A, RUN_A)).toBe(false);

  const sessionSubscription = await session.subscribe(owner.connection, SESSION_A);
  expect(sessionSubscription.ok).toBe(true);
  expect(session.isAttached(owner.connection, SESSION_A)).toBe(true);
  expect(session.isAttached(owner.connection, SESSION_B)).toBe(false);
  expect(session.isAttached(foreign.connection, SESSION_A)).toBe(false);
  owner.close();
  await Promise.resolve();
  expect(session.isAttached(owner.connection, SESSION_A)).toBe(false);
  run.close();
  session.close();
  permissions.close();
});
