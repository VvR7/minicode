import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessageId } from "@minicode/protocol";
import { AgentRunner } from "../../src/run/runner.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { SessionStore, buildContextEntries } from "../../src/session/session-store.ts";
import { EventBus } from "../../src/events/event-bus.ts";
import { EventStore } from "../../src/events/event-store.ts";
import { SessionEventBus } from "../../src/events/session-event-bus.ts";
import { RunMetadataStore } from "../../src/run/metadata.ts";
import { RunTraceRegistry } from "../../src/trace/registry.ts";
import { LlmError } from "../../src/llm/errors.ts";
import {
  FakeProvider,
  textResponse,
  toolResponse,
  toolCall,
  usage,
} from "../agent/test-helpers.ts";

/** 解包必须成功的测试准备结果。 */
function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("setup failed");
  return result.value;
}

/** 等待唯一 run 提交，避免在历史落盘前读取 checkpoint。 */
async function idle(manager: SessionManager) {
  const deadline = performance.now() + 3000;
  while (manager.activeCount > 0) {
    if (performance.now() > deadline) throw new Error("run did not settle");
    await Bun.sleep(2);
  }
}

describe("compaction run journal integration", () => {
  for (const succeeds of [true, false]) {
    test(`runtime message identity survives compaction and ${succeeds ? "success" : "failure"} restart`, async () => {
      const home = await mkdtemp(join(tmpdir(), "minicode-compact-lifecycle-"));
      const environment = {
        LLM_API_KEY: "test-key",
        LLM_BASE_URL: "http://localhost:1",
        LLM_MODEL: "test-model",
        LLM_CONTEXT_WINDOW_TOKENS: "100000",
        LLM_MAX_OUTPUT_TOKENS: "4096",
        MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "100",
        MINICODE_TRACE_ENABLED: "false",
      };
      const store = new SessionStore(home);
      const eventStore = new EventStore(home);
      const bus = new EventBus(eventStore);
      const sessionEvents = new SessionEventBus(store);
      const provider = new FakeProvider([
        {
          response: {
            ...toolResponse([toolCall("read-call", "read", { path: "input.txt" })]),
            usage: usage({ inputTokens: 95000 }),
          },
        },
        { response: textResponse("Original Request: inspect input; progress: read started") },
        succeeds
          ? { response: textResponse("done") }
          : { error: new LlmError("network_error", "failed") },
      ]);
      const runner = new AgentRunner({
        environment,
        bus,
        homeDirectory: home,
        providerFactory: () => provider,
      });
      const metadata = new RunMetadataStore(home);
      let manager = new SessionManager({
        store,
        runner,
        eventBus: bus,
        eventStore,
        sessionEvents,
        metadata,
        traces: new RunTraceRegistry(home, environment),
        environment,
      });
      try {
        await writeFile(join(home, "input.txt"), "content\n".repeat(300));
        await manager.ready();
        const session = must(await manager.create(home));
        const prepared = must(
          await manager.prepareMessage({
            sessionId: session.sessionId,
            clientMessageId: crypto.randomUUID() as ClientMessageId,
            content: "inspect input.txt",
          }),
        );
        prepared.activate();
        await idle(manager);
        const snapshot = must(await store.load(session.sessionId));
        expect(snapshot.compactions).toHaveLength(1);
        expect(snapshot.turns[0]?.status).toBe(succeeds ? "succeeded" : "failed");
        const retained = snapshot.compactions[0]?.checkpoint.firstKeptMessageId;
        expect(snapshot.turns[0]?.messages.some((message) => message.messageId === retained)).toBe(
          true,
        );
        expect(snapshot.turns[0]?.messages[0]?.content[0]).toEqual({
          type: "text",
          text: "inspect input.txt",
        });
        expect(provider.calls).toHaveLength(3);
        expect(provider.calls[1]?.options?.toolSchemas).toEqual([]);
        expect(provider.calls[2]?.messages[0]?.content[0]?.type).toBe("text");
        expect(
          snapshot.turns[0]?.messages.filter((message) =>
            message.content.some((part) => part.type === "tool_result"),
          ),
        ).toHaveLength(1);
        await manager.shutdown();
        const recoveredStore = new SessionStore(home);
        const recoveredEvents = new SessionEventBus(recoveredStore);
        manager = new SessionManager({
          store: recoveredStore,
          runner,
          eventBus: bus,
          eventStore,
          sessionEvents: recoveredEvents,
          metadata,
          traces: new RunTraceRegistry(home, environment),
          environment,
        });
        await manager.ready();
        const recovered = must(await recoveredStore.load(session.sessionId));
        expect(must(await manager.get(session.sessionId)).status).toBe("idle");
        const entries = buildContextEntries(recovered.turns, recovered.compactions);
        expect(entries.some((entry) => entry.metadata?.kind === "summary")).toBe(succeeds);
        if (!succeeds) expect(entries).toHaveLength(0);
      } finally {
        await manager.shutdown();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
