import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApp, SessionStore, buildContextEntries } from "../../packages/core/src/index.ts";
import { SessionController, type SessionControllerEvent } from "../../packages/client/src/index.ts";
import {
  startScriptedAnthropicMock,
  type ScriptedReply,
} from "./helpers/scripted-anthropic-mock.ts";

/** 解包必须成功的测试准备结果。 */
function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("setup failed");
  return result.value;
}

/** 等待事件或 journal 就绪，以单调时钟避免系统时间调整影响测试。 */
async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("lifecycle did not settle");
    await Bun.sleep(2);
  }
}

/** 生成与生产配置同样的窗口与摘要预算。 */
function environment(url: string) {
  return {
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: url,
    LLM_MODEL: "stage4-test",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "100",
    MINICODE_TRACE_ENABLED: "false",
  };
}

/** 创建真实 Core daemon 资源，由测试显式重启同一 home。 */
function core(home: string, url: string) {
  return new CoreApp(
    { host: "127.0.0.1", port: 0, homeDirectory: home, logLevel: "error" },
    environment(url),
  );
}

/** 提交目标并等待权威 turn 提交事件，不把摘要当成 assistant 回答。 */
async function send(controller: SessionController, events: SessionControllerEvent[], goal: string) {
  const commits = events.filter((event) => event.type === "turn.committed").length;
  await controller.sendMessage(goal);
  await waitFor(() => events.filter((event) => event.type === "turn.committed").length > commits);
}

/** 解码摘要请求中的唯一文本，便于检查增量范围与 run 前缀。 */
function prompt(body: unknown): string {
  if (body === null || typeof body !== "object") throw new Error("missing request");
  const messages = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) throw new Error("missing messages");
  return JSON.stringify(messages);
}

describe("Stage4 complete lifecycle", () => {
  test("restart resumes incremental checkpoints, splits run prefixes and isolates another session", async () => {
    const home = await mkdtemp(join(tmpdir(), "minicode-stage4-lifecycle-"));
    await writeFile(join(home, "first.txt"), "FIRST_FILE ".repeat(300));
    await writeFile(join(home, "second.txt"), "SECOND_FILE ".repeat(300));
    const replies: ScriptedReply[] = [
      {
        kind: "tools",
        inputTokens: 95000,
        calls: [{ id: "first-read", name: "read", input: { path: "first.txt" } }],
      },
      { kind: "text", chunks: ["SUMMARY_A"] },
      { kind: "text", chunks: ["ANSWER_A ".repeat(150)] },
      {
        kind: "tools",
        inputTokens: 95000,
        calls: [{ id: "second-read", name: "read", input: { path: "second.txt" } }],
      },
      { kind: "text", chunks: ["SUMMARY_B_HISTORY"] },
      { kind: "text", chunks: ["SUMMARY_B_PREFIX"] },
      { kind: "text", chunks: ["ANSWER_B ".repeat(150)] },
      { kind: "text", chunks: ["ISOLATED_ANSWER"] },
      { kind: "text", chunks: ["MANUAL_PREFIX"] },
    ];
    const mock = startScriptedAnthropicMock((_body, call) => {
      const reply = replies[call - 1];
      if (reply === undefined) throw new Error(`unexpected call ${call}`);
      return reply;
    });
    let app = core(home, mock.url);
    let endpoint = app.start();
    const events: SessionControllerEvent[] = [],
      peerEvents: SessionControllerEvent[] = [];
    let controller = new SessionController({
      endpoint,
      onEvent: (event) => {
        events.push(event);
      },
    });
    let peer: SessionController | undefined;
    try {
      const session = await controller.create(home);
      await send(controller, events, "GOAL_A inspect first.txt");
      const beforeRestart = must(await new SessionStore(home).load(session.sessionId));
      expect(beforeRestart.compactions).toHaveLength(1);
      expect(beforeRestart.compactions[0]?.checkpoint.summary).toContain("SUMMARY_A");
      expect(beforeRestart.turns[0]?.messages).toHaveLength(4);
      expect(
        events
          .filter((event) => event.type === "run.event" && event.event.type === "llm.text_delta")
          .map((event) => JSON.stringify(event))
          .join(""),
      ).not.toContain("SUMMARY_A");
      await controller.dispose();
      await app.stop();
      app = core(home, mock.url);
      endpoint = app.start();
      controller = new SessionController({
        endpoint,
        onEvent: (event) => {
          events.push(event);
        },
      });
      await controller.attach(session.sessionId);
      await send(controller, events, "GOAL_B inspect second.txt");
      const afterRestart = must(await new SessionStore(home).load(session.sessionId));
      expect(afterRestart.compactions).toHaveLength(2);
      expect(afterRestart.turns).toHaveLength(2);
      expect(afterRestart.turns[1]?.messages).toHaveLength(4);
      const checkpoint = afterRestart.compactions[1]?.checkpoint;
      expect(checkpoint?.summary).toContain("SUMMARY_B_HISTORY");
      expect(checkpoint?.summary).toContain("SUMMARY_B_PREFIX");
      expect(checkpoint?.readFiles).toEqual(["first.txt"]);
      expect(prompt(mock.requestBodies[3])).toContain("SUMMARY_A");
      const historyPrompt = prompt(mock.requestBodies[4]);
      expect(historyPrompt).toContain("SUMMARY_A");
      expect(historyPrompt).toContain("FIRST_FILE");
      expect(historyPrompt).not.toContain("GOAL_A");
      expect(historyPrompt).not.toContain("GOAL_B");
      expect(prompt(mock.requestBodies[5])).toContain("GOAL_B");
      expect(prompt(mock.requestBodies[6])).toContain("SUMMARY_B_HISTORY");
      expect(prompt(mock.requestBodies[6])).toContain("SUMMARY_B_PREFIX");
      expect(JSON.stringify(mock.requestBodies[6])).not.toContain("messageId");
      expect(JSON.stringify(mock.requestBodies[6])).not.toContain("metadata");
      peer = new SessionController({
        endpoint,
        onEvent: (event) => {
          peerEvents.push(event);
        },
      });
      const peerSession = await peer.create(home);
      await send(peer, peerEvents, "ISOLATED_GOAL");
      expect(prompt(mock.requestBodies[7])).not.toContain("SUMMARY_");
      expect(prompt(mock.requestBodies[7])).not.toContain("FIRST_FILE");
      const manual = await controller.compact("focus on files");
      expect(manual.status).toBe("compacted");
      expect(prompt(mock.requestBodies[8])).toContain("focus on files");
      const final = must(await new SessionStore(home).load(session.sessionId));
      expect(final.compactions[2]?.checkpoint.summary).toContain("SUMMARY_B_HISTORY");
      expect(final.compactions[2]?.checkpoint.readFiles).toEqual(["first.txt", "second.txt"]);
      expect(final.turns).toHaveLength(2);
      expect(peerEvents.filter((event) => event.type === "session.compaction")).toHaveLength(0);
      expect(
        must(await new SessionStore(home).load(peerSession.sessionId)).compactions,
      ).toHaveLength(0);
      expect(mock.callCount).toBe(9);
    } finally {
      await controller.dispose();
      await peer?.dispose();
      await app.stop();
      await mock.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  for (const outcome of [
    "retry_success",
    "second_overflow",
    "summary_fallback",
    "summary_failure",
  ] as const) {
    test(`real provider context error: ${outcome}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "minicode-stage4-overflow-"));
      const overflow: ScriptedReply = { kind: "error", status: 400, message: "prompt is too long" };
      const ordinaryError: ScriptedReply = {
        kind: "error",
        status: 400,
        message: "invalid request",
      };
      const replies: ScriptedReply[] = [
        { kind: "text", chunks: ["answer ".repeat(100)] },
        overflow,
        outcome === "summary_fallback"
          ? overflow
          : outcome === "summary_failure"
            ? ordinaryError
            : { kind: "text", chunks: ["RESUME_SUMMARY"] },
        outcome === "second_overflow"
          ? overflow
          : outcome === "summary_failure"
            ? ordinaryError
            : { kind: "text", chunks: ["recovered"] },
      ];
      const mock = startScriptedAnthropicMock((_body, call) => {
        const reply = replies[call - 1];
        if (reply === undefined) throw new Error(`unexpected call ${call}`);
        return reply;
      });
      const app = core(home, mock.url);
      const endpoint = app.start();
      const events: SessionControllerEvent[] = [];
      const controller = new SessionController({
        endpoint,
        onEvent: (event) => {
          events.push(event);
        },
      });
      try {
        const session = await controller.create(home);
        await send(controller, events, "OLD_GOAL ".repeat(1000));
        await send(controller, events, "CURRENT_GOAL");
        const loaded = must(await new SessionStore(home).load(session.sessionId));
        const succeeds = outcome === "retry_success" || outcome === "summary_fallback";
        expect(loaded.turns[1]?.status).toBe(succeeds ? "succeeded" : "failed");
        expect(loaded.turns[1]?.messages[0]?.content[0]).toEqual({
          type: "text",
          text: "CURRENT_GOAL",
        });
        expect(loaded.turns[0]?.messages[0]?.content[0]).toEqual({
          type: "text",
          text: "OLD_GOAL ".repeat(1000).trim(),
        });
        expect(loaded.compactions).toHaveLength(outcome === "summary_failure" ? 0 : 1);
        if (outcome === "summary_fallback") {
          expect(loaded.compactions[0]?.checkpoint.kind).toBe("fallback");
          expect(loaded.compactions[0]?.checkpoint.summary).toContain("hidden");
        }
        const secondRun = loaded.turns[1]?.runId;
        expect(
          events.filter(
            (event) =>
              event.type === "run.event" &&
              event.event.runId === secondRun &&
              event.event.type === "step.started",
          ),
        ).toHaveLength(1);
        if (outcome === "second_overflow") {
          const result = loaded.runResults[secondRun ?? ""];
          expect(result?.status === "failed" && result.error?.code).toBe("context_limit_exceeded");
          expect(
            buildContextEntries(loaded.turns, loaded.compactions).some(
              (entry) => entry.metadata !== undefined,
            ),
          ).toBe(false);
        }
        if (outcome === "summary_failure")
          expect(
            events.some(
              (event) =>
                event.type === "session.compaction" &&
                event.event.type === "session.compaction_failed",
            ),
          ).toBe(true);
        expect(mock.callCount).toBe(4);
        expect(JSON.stringify(mock.requestBodies[2])).not.toContain('"tools":[{');
      } finally {
        await controller.dispose();
        await app.stop();
        await mock.stop();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

describe("Stage4 cancelled checkpoint recovery", () => {
  test("cancelled compressed run retains tool audit and excludes its checkpoint from the next turn", async () => {
    const { createBarrier } = await import("./helpers/scripted-anthropic-mock.ts");
    const home = await mkdtemp(join(tmpdir(), "minicode-stage4-cancel-"));
    await writeFile(join(home, "input.txt"), "input ".repeat(300));
    const barrier = createBarrier();
    const mock = startScriptedAnthropicMock((_body, call) => {
      if (call === 1)
        return {
          kind: "tools",
          inputTokens: 95000,
          calls: [{ id: "read", name: "read", input: { path: "input.txt" } }],
        };
      if (call === 2) return { kind: "text", chunks: ["CANCELLED_SUMMARY"] };
      if (call === 3) return { kind: "text", chunks: ["partial"], barrier };
      return { kind: "text", chunks: ["next answer"] };
    });
    const app = core(home, mock.url);
    const endpoint = app.start();
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      endpoint,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      const session = await controller.create(home);
      await controller.sendMessage("inspect input");
      await barrier.reached;
      await controller.cancelActiveRun();
      await waitFor(() => events.some((event) => event.type === "turn.committed"));
      const cancelled = must(await new SessionStore(home).load(session.sessionId));
      expect(cancelled.compactions).toHaveLength(1);
      expect(cancelled.turns[0]?.status).toBe("cancelled");
      expect(cancelled.turns[0]?.messages).toHaveLength(3);
      expect(
        cancelled.turns[0]?.messages[1]?.content.some((part) => part.type === "tool_use"),
      ).toBe(true);
      expect(
        cancelled.turns[0]?.messages[2]?.content.some((part) => part.type === "tool_result"),
      ).toBe(true);
      expect(buildContextEntries(cancelled.turns, cancelled.compactions)).toHaveLength(0);
      await send(controller, events, "continue after cancel");
      expect(prompt(mock.requestBodies[3])).not.toContain("CANCELLED_SUMMARY");
      expect(prompt(mock.requestBodies[3])).not.toContain("tool_result");
      expect(mock.callCount).toBe(4);
    } finally {
      barrier.release();
      await controller.dispose();
      await app.stop();
      await mock.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("Stage4 interrupted checkpoint recovery", () => {
  test("a killed daemon restores the previous context without continuing hidden tools", async () => {
    const { NdjsonRpcConnection } = await import("../../packages/client/src/index.ts");
    const { createBarrier } = await import("./helpers/scripted-anthropic-mock.ts");
    const home = await mkdtemp(join(tmpdir(), "minicode-stage4-killed-"));
    await writeFile(join(home, "input.txt"), "input ".repeat(300));
    const barrier = createBarrier();
    const mock = startScriptedAnthropicMock((_body, call) => {
      if (call === 1)
        return {
          kind: "tools",
          inputTokens: 95000,
          calls: [{ id: "read", name: "read", input: { path: "input.txt" } }],
        };
      if (call === 2) return { kind: "text", chunks: ["INTERRUPTED_SUMMARY"] };
      return { kind: "text", chunks: ["partial"], barrier };
    });
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { /** 临时 listener 仅分配空闲端口。 */ data() {} },
    });
    const port = probe.port;
    probe.stop(true);
    const endpoint = { host: "127.0.0.1" as const, port };
    /** 使用同一 home 和端口启动真实 daemon；SIGKILL 用于模拟未提交 run 的崩溃。 */
    const spawn = () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "../../packages/core/src/bin.ts")], {
        cwd: home,
        env: {
          ...process.env,
          ...environment(mock.url),
          MINICODE_HOME: home,
          MINICODE_CORE_HOST: "127.0.0.1",
          MINICODE_CORE_PORT: String(port),
          MINICODE_LOG_LEVEL: "error",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
    /** 等待 socket 就绪，重启后的 session RPC 另行等待 history 恢复。 */
    const listening = async () => {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        try {
          const connection = await NdjsonRpcConnection.connect(endpoint, { timeoutMs: 100 });
          connection.close();
          return;
        } catch {
          await Bun.sleep(10);
        }
      }
      throw new Error("daemon did not listen");
    };
    let child = spawn();
    const events: SessionControllerEvent[] = [];
    let controller = new SessionController({
      endpoint,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await listening();
      const session = await controller.create(home);
      await controller.sendMessage("inspect interrupted input");
      await barrier.reached;
      expect(must(await new SessionStore(home).load(session.sessionId)).compactions).toHaveLength(
        1,
      );
      child.kill("SIGKILL");
      await child.exited;
      await controller.dispose();
      child = spawn();
      await listening();
      controller = new SessionController({
        endpoint,
        onEvent: (event) => {
          events.push(event);
        },
      });
      await controller.attach(session.sessionId);
      const recovered = must(await new SessionStore(home).load(session.sessionId));
      expect(recovered.status).toBe("idle");
      expect(recovered.turns[0]?.status).toBe("interrupted");
      expect(recovered.turns[0]?.reason).toBe("core_restarted");
      expect(recovered.compactions).toHaveLength(1);
      expect(buildContextEntries(recovered.turns, recovered.compactions)).toHaveLength(0);
      expect(mock.callCount).toBe(3);
    } finally {
      barrier.release();
      await controller.dispose();
      child.kill("SIGTERM");
      await child.exited;
      await mock.stop();
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);
});

test("Stage4 rejects a retained context that cannot fit without committing or recursively shrinking", async () => {
  const home = await mkdtemp(join(tmpdir(), "minicode-stage4-nonfit-"));
  const replies: ScriptedReply[] = [
    { kind: "text", chunks: ["answer-a ".repeat(100)] },
    { kind: "text", chunks: ["answer-b ".repeat(100)] },
    { kind: "text", chunks: ["H".repeat(9000)] },
    { kind: "text", chunks: ["P".repeat(6000)] },
  ];
  const mock = startScriptedAnthropicMock((_body, call) => {
    const reply = replies[call - 1];
    if (reply === undefined) throw new Error("unexpected recursive compression");
    return reply;
  });
  const app = new CoreApp(
    { host: "127.0.0.1", port: 0, homeDirectory: home, logLevel: "error" },
    {
      ...environment(mock.url),
      LLM_CONTEXT_WINDOW_TOKENS: "8000",
      MINICODE_COMPACTION_RESERVE_TOKENS: "4096",
      MINICODE_COMPACTION_ENABLED: "false",
    },
  );
  const endpoint = app.start();
  const events: SessionControllerEvent[] = [];
  const controller = new SessionController({
    endpoint,
    onEvent: (event) => {
      events.push(event);
    },
  });
  try {
    const session = await controller.create(home);
    await send(controller, events, "first goal");
    await send(controller, events, "second goal");
    await expect(controller.compact("focus")).rejects.toMatchObject({ code: -32013 });
    const snapshot = must(await new SessionStore(home).load(session.sessionId));
    expect(snapshot.compactions).toHaveLength(0);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.sessionEvents.at(-1)?.type).toBe("session.compaction_failed");
    expect(mock.callCount).toBe(4);
    expect(prompt(mock.requestBodies[2])).toContain("focus");
    expect(prompt(mock.requestBodies[3])).toContain("focus");
  } finally {
    await controller.dispose();
    await app.stop();
    await mock.stop();
    await rm(home, { recursive: true, force: true });
  }
});
