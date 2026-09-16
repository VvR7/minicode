import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApp, EventStore } from "../../packages/core/src/index.ts";
import { NdjsonRpcConnection } from "../../packages/client/src/index.ts";
import {
  AgentRunResultSchema,
  AgentCancelResultSchema,
  EventSubscribeResultSchema,
  EventPushNotificationSchema,
  PermissionRespondResultSchema,
  isAgentEvent,
  type AgentEvent,
} from "../../packages/protocol/src/index.ts";
import { startScriptedAnthropicMock } from "./helpers/scripted-anthropic-mock.ts";

/** 在测试 deadline 内等待真实 IPC 事件。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("permission flow timed out");
    await Bun.sleep(5);
  }
}

/** 创建会请求 write 审批的真实 daemon 与独立 IPC 连接。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "minicode-permission-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "minicode-permission-workspace-"));
  const mock = startScriptedAnthropicMock((_body, call) =>
    call === 1
      ? {
          kind: "tools",
          calls: [
            {
              id: "write-1",
              name: "write",
              input: { path: "approved.txt", content: "approved content" },
            },
          ],
        }
      : { kind: "text", chunks: ["done"] },
  );
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    logLevel: "error" as const,
    homeDirectory: home,
  };
  const environment = {
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: mock.url,
    LLM_MODEL: "test-model",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    MINICODE_TRACE_ENABLED: "false",
  };
  const app = new CoreApp(config, environment);
  const endpoint = app.start();
  const owner = await NdjsonRpcConnection.connect(endpoint);
  const observer = await NdjsonRpcConnection.connect(endpoint);
  const stranger = await NdjsonRpcConnection.connect(endpoint);
  const events: AgentEvent[] = [];
  owner.onNotification((notification) => {
    const parsed = EventPushNotificationSchema.safeParse(notification);
    if (parsed.success && isAgentEvent(parsed.data.params.event))
      events.push(parsed.data.params.event);
  });
  const accepted = await owner.request(
    "agent.run",
    { goal: "write a file", workspaceRoot: workspace },
    AgentRunResultSchema,
  );
  await waitFor(() => events.some((event) => event.type === "permission.requested"));
  const request = events.find((event) => event.type === "permission.requested");
  if (request?.type !== "permission.requested") throw new Error("missing approval");
  const response = {
    sessionId: accepted.result.sessionId,
    runId: accepted.result.runId,
    permissionRequestId: request.payload.permissionRequestId,
    decision: "allow_once" as const,
  };
  return {
    home,
    workspace,
    app,
    config,
    environment,
    owner,
    observer,
    stranger,
    events,
    response,
    /** 释放连接、daemon、mock 和本测试创建的目录。 */
    async cleanup() {
      owner.close();
      observer.close();
      stranger.close();
      await app.stop();
      await mock.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

describe("Core permission flow (integration)", () => {
  test("unattached connections cannot respond; first attached response wins before write executes", async () => {
    const f = await fixture();
    try {
      await expect(readFile(join(f.workspace, "approved.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await f.stranger.request("permission.respond", f.response, PermissionRespondResultSchema))
          .result.outcome,
      ).toBe("not_found");
      await f.observer.request(
        "event.subscribe",
        { sessionId: f.response.sessionId, runId: f.response.runId },
        EventSubscribeResultSchema,
      );
      const [first, second] = await Promise.all([
        f.observer.request("permission.respond", f.response, PermissionRespondResultSchema),
        f.owner.request(
          "permission.respond",
          { ...f.response, decision: "deny_once" },
          PermissionRespondResultSchema,
        ),
      ]);
      expect([first.result.outcome, second.result.outcome].sort()).toEqual([
        "accepted",
        "already_resolved",
      ]);
      await waitFor(() => f.events.some((event) => event.type === "run.finished"));
      const resolved = f.events.find((event) => event.type === "permission.resolved");
      expect(resolved?.type).toBe("permission.resolved");
      if (resolved?.type === "permission.resolved" && resolved.payload.allowed) {
        expect(await readFile(join(f.workspace, "approved.txt"), "utf8")).toBe("approved content");
      } else {
        await expect(readFile(join(f.workspace, "approved.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(f.events.filter((event) => event.type === "permission.resolved")).toHaveLength(1);
      expect(f.events.filter((event) => event.type === "tool.finished")).toHaveLength(1);
      const requestedIndex = f.events.findIndex((event) => event.type === "permission.requested");
      const resolvedIndex = f.events.findIndex((event) => event.type === "permission.resolved");
      const toolIndex = f.events.findIndex((event) => event.type === "tool.finished");
      expect(requestedIndex).toBeLessThan(resolvedIndex);
      expect(resolvedIndex).toBeLessThan(toolIndex);
    } finally {
      await f.cleanup();
    }
  });

  test("cancelling a pending approval emits a terminal and never writes", async () => {
    const f = await fixture();
    try {
      await f.owner.request(
        "agent.cancel",
        { sessionId: f.response.sessionId, runId: f.response.runId },
        AgentCancelResultSchema,
      );
      await waitFor(() => f.events.some((event) => event.type === "run.finished"));
      expect(f.events.find((event) => event.type === "run.finished")).toMatchObject({
        payload: { status: "cancelled" },
      });
      expect(f.events.some((event) => event.type === "permission.resolved")).toBe(false);
      await expect(readFile(join(f.workspace, "approved.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("shutdown releases pending approval; restarted daemon replays terminal instead of resuming it", async () => {
    const f = await fixture();
    try {
      await f.app.stop();
      const restarted = new CoreApp(f.config, f.environment);
      const client = await NdjsonRpcConnection.connect(restarted.start());
      try {
        expect(
          (await client.request("permission.respond", f.response, PermissionRespondResultSchema))
            .result.outcome,
        ).toBe("not_found");
        const replay: AgentEvent[] = [];
        client.onNotification((notification) => {
          const parsed = EventPushNotificationSchema.safeParse(notification);
          if (parsed.success && isAgentEvent(parsed.data.params.event))
            replay.push(parsed.data.params.event);
        });
        await client.request(
          "event.subscribe",
          { sessionId: f.response.sessionId, runId: f.response.runId },
          EventSubscribeResultSchema,
        );
        await waitFor(() => replay.some((event) => event.type === "run.finished"));
        expect(replay.some((event) => event.type === "permission.requested")).toBe(true);
        expect(replay.find((event) => event.type === "run.finished")).toMatchObject({
          payload: { status: "cancelled" },
        });
        const journal = await new EventStore(f.home).read(f.response.sessionId, f.response.runId);
        expect(
          journal.ok && journal.value.events.filter((event) => event.type === "run.finished"),
        ).toHaveLength(1);
        await expect(readFile(join(f.workspace, "approved.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        client.close();
        await restarted.stop();
      }
    } finally {
      await f.cleanup();
    }
  });
});
