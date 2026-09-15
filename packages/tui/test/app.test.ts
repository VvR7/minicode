import { afterEach, describe, expect, test } from "bun:test";
import type { SessionControllerEvent } from "@minicode/client";
import type { SessionSummary } from "@minicode/protocol";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp, type TuiSessionController } from "../src/app.ts";
import type { TuiLaunchMode } from "../src/options.ts";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const turnId = "750e8400-e29b-41d4-a716-446655440001";
const summary: SessionSummary = {
  sessionId,
  mode: "chat",
  status: "idle",
  title: "Chat",
  workspaceRoot: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestSessionSequence: 0,
};

/** 可编程 controller，用于只测试 TUI 状态机而不重复测试 IPC。 */
class FakeController implements TuiSessionController {
  readonly sent: string[] = [];
  cancelCalls = 0;
  disposeCalls = 0;
  createCalls = 0;
  sessions: SessionSummary[];
  #consume: (event: SessionControllerEvent) => void;
  constructor(consume: (event: SessionControllerEvent) => void, sessions: SessionSummary[]) {
    this.#consume = consume;
    this.sessions = sessions;
  }
  /** 创建并附着默认会话。 */
  async create(): Promise<SessionSummary> {
    this.createCalls += 1;
    const created =
      this.createCalls === 1
        ? summary
        : { ...summary, sessionId: "950e8400-e29b-41d4-a716-446655440004" };
    this.#consume({ type: "controller.status", status: "connected" });
    this.#consume({ type: "session.attached", session: created });
    return created;
  }
  /** 附着列表中的会话。 */
  async attach(id: string): Promise<void> {
    const session = this.sessions.find((item) => item.sessionId === id);
    if (session === undefined) throw new Error("missing");
    this.#consume({ type: "session.attached", session });
  }
  /** 按 workspace 和 mode 模拟服务端过滤。 */
  async list(options: { workspaceRoot?: string; includeOneShot?: boolean } = {}) {
    return {
      sessions: this.sessions.filter(
        (item) =>
          (options.workspaceRoot === undefined || item.workspaceRoot === options.workspaceRoot) &&
          (options.includeOneShot === true || item.mode !== "one_shot"),
      ),
    };
  }
  /** 记录提交，不生成乐观事件。 */
  async sendMessage(content: string): Promise<void> {
    this.sent.push(content);
  }
  /** 记录取消次数。 */
  async cancelActiveRun(): Promise<void> {
    this.cancelCalls += 1;
  }
  /** 记录资源释放。 */
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
  /** 向应用广播权威事件。 */
  emit(event: SessionControllerEvent): void {
    this.#consume(event);
  }
}

const renderers: { destroy(): void }[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
});

/** 启动 headless TUI 并暴露真实 OpenTUI mock input。 */
async function start(
  mode: TuiLaunchMode = { kind: "new" },
  sessions: SessionSummary[] = [summary],
) {
  const setup = await createTestRenderer({
    width: 90,
    height: 14,
    exitOnCtrlC: false,
    kittyKeyboard: true,
  });
  renderers.push(setup.renderer);
  let fake: FakeController | undefined;
  const code = new TuiApp().run({
    mode,
    workspaceRoot: "/work",
    endpoint: { host: "127.0.0.1", port: 7437 },
    model: "test-model",
    contextWindowTokens: 100_000,
    createRenderer: async () => setup.renderer,
    createController: (consume) => {
      fake = new FakeController(consume, sessions);
      return fake;
    },
  });
  await setup.waitForFrame((frame) =>
    frame.includes(
      mode.kind === "sessions"
        ? "[SESSIONS]"
        : mode.kind === "session" || mode.kind === "continue"
          ? "session"
          : "context --/100k",
    ),
  );
  if (fake === undefined) throw new Error("controller was not created");
  return { setup, controller: fake, code };
}

/** 通过真实 Textarea key event 输入本地退出命令。 */
async function exit(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  await setup.mockInput.typeText("/exit");
  setup.mockInput.pressEnter();
}

describe("TuiApp multi-turn interaction", () => {
  test("renders assistant Markdown and keeps usage/model in the footer", async () => {
    const { setup, controller, code } = await start();
    controller.emit({
      type: "run.event",
      event: {
        sessionId,
        runId,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        durable: true,
        type: "llm.model_selected",
        payload: { model: "deepseek-flash", provider: "anthropic" },
      },
    });
    controller.emit({
      type: "run.event",
      event: {
        sessionId,
        runId,
        sequence: 2,
        timestamp: "2026-01-01T00:00:00.000Z",
        durable: true,
        type: "llm.text_delta",
        payload: { text: "# Heading\n\n- **bold item**" },
      },
    });
    controller.emit({
      type: "run.event",
      event: {
        sessionId,
        runId,
        sequence: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        durable: true,
        type: "llm.usage",
        payload: {
          inputTokens: 10_000,
          outputTokens: 500,
          cacheReadInputTokens: 89_000,
          cacheCreationInputTokens: 500,
          contextWindowTokens: 200_000,
        },
      },
    });
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Heading") &&
        frame.includes("bold item") &&
        frame.includes("context 100k/200k 50.0%") &&
        frame.includes("deepseek-flash"),
    );
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("**bold item**");
    expect(frame).not.toContain("[USAGE]");
    expect(frame).not.toContain("[MODEL]");
    await exit(setup);
    expect(await code).toBe(0);
  });

  test("Enter sends while Ctrl+Enter inserts a newline at the OpenTUI key layer", async () => {
    const { setup, controller, code } = await start();
    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter({ ctrl: true });
    await setup.mockInput.typeText("world");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => controller.sent.length === 1);
    expect(controller.sent).toEqual(["hello\nworld"]);
    expect(setup.captureCharFrame()).not.toContain("[YOU] hello");
    controller.emit({
      type: "turn.accepted",
      sessionId,
      sessionSequence: 1,
      turnId,
      runId,
      clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
      userMessage: "hello\nworld",
    });
    await setup.waitForFrame((frame) => frame.includes("[YOU] hello"));
    controller.emit({
      type: "turn.committed",
      sessionId,
      sessionSequence: 2,
      turnId,
      runId,
      status: "succeeded",
      reason: "completed",
    });
    await exit(setup);
    expect(await code).toBe(0);
  });
  test("q is ordinary input and Ctrl+C clears a draft without cancelling", async () => {
    const { setup, controller, code } = await start();
    await setup.mockInput.typeText("q draft");
    await setup.waitForFrame((frame) => frame.includes("q draft"));
    setup.mockInput.pressCtrlC();
    await setup.waitForFrame((frame) => frame.includes("draft cleared"));
    expect(controller.cancelCalls).toBe(0);
    await exit(setup);
    expect(await code).toBe(0);
  });
  test("busy state blocks submit; Ctrl+C cancels once and /exit does not force exit", async () => {
    const { setup, controller, code } = await start();
    await setup.mockInput.typeText("/exit");
    controller.emit({
      type: "turn.accepted",
      sessionId,
      sessionSequence: 1,
      turnId,
      runId,
      clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
      userMessage: "remote",
    });
    await setup.waitForFrame((frame) => frame.includes("running"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(
      (frame) => frame.includes("run is active") && frame.includes("Ctrl+C"),
    );
    expect(controller.sent).toHaveLength(0);
    expect(controller.disposeCalls).toBe(0);
    // 第一次清除竞争期间保留的本地草稿，第二次才取消；后续按键不得重复 RPC。
    setup.mockInput.pressCtrlC();
    setup.mockInput.pressCtrlC();
    setup.mockInput.pressCtrlC();
    await setup.waitFor(() => controller.cancelCalls === 1);
    controller.emit({
      type: "turn.committed",
      sessionId,
      sessionSequence: 2,
      turnId,
      runId,
      status: "cancelled",
      reason: "cancelled",
    });
    await exit(setup);
    expect(await code).toBe(0);
  });
  test("rejects an over-limit draft and shows the over-limit counter", async () => {
    const { setup, controller, code } = await start();
    await setup.mockInput.pasteBracketedText("x".repeat(32769));
    await setup.waitForFrame((frame) => frame.includes("1 over limit"));
    setup.mockInput.pressEnter();
    expect(controller.sent).toHaveLength(0);
    setup.mockInput.pressCtrlC();
    await exit(setup);
    expect(await code).toBe(0);
  });
  test("/new switches only this controller and clears the old transcript", async () => {
    const { setup, controller, code } = await start();
    controller.emit({
      type: "turn.snapshot",
      turn: {
        turnId,
        runId,
        clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
        status: "succeeded",
        reason: "completed",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        includedInContext: true,
        messages: [
          {
            messageId: "u",
            turnId,
            runId,
            role: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            content: [{ type: "text", text: "old message" }],
          },
          {
            messageId: "a",
            turnId,
            runId,
            role: "assistant",
            timestamp: "2026-01-01T00:00:01.000Z",
            content: [{ type: "text", text: "## Old heading\n\n- **restored item**" }],
          },
        ],
      },
    });
    await setup.waitForFrame((frame) => frame.includes("restored item"));
    expect(setup.captureCharFrame()).not.toContain("**restored item**");
    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => controller.createCalls === 2);
    await setup.waitForFrame((frame) => frame.includes("session 950e8400"));
    expect(setup.captureCharFrame()).not.toContain("old message");
    expect(setup.captureCharFrame()).not.toContain("restored item");
    await exit(setup);
    expect(await code).toBe(0);
  });
  test("--goal submits after attach and one-shot resumes read-only", async () => {
    const goal = await start({ kind: "new", goal: "first question" });
    await goal.setup.waitFor(() => goal.controller.sent.length === 1);
    expect(goal.controller.sent).toEqual(["first question"]);
    await exit(goal.setup);
    await goal.code;
    const audit = { ...summary, mode: "one_shot" as const };
    const resumed = await start({ kind: "session", sessionId }, [audit]);
    await resumed.setup.waitForFrame((frame) => frame.includes("read-only"));
    expect(resumed.controller.sent).toHaveLength(0);
    await resumed.setup.mockInput.typeText("not allowed");
    resumed.setup.mockInput.pressEnter();
    await resumed.setup.waitForFrame((frame) => frame.includes("read-only"));
    expect(resumed.controller.sent).toHaveLength(0);
    resumed.setup.mockInput.pressCtrlC();
    await resumed.setup.mockInput.typeText("/new");
    resumed.setup.mockInput.pressEnter();
    await resumed.setup.waitForFrame((frame) => frame.includes("this session is read-only"));
    expect(resumed.controller.createCalls).toBe(0);
    resumed.setup.mockInput.pressCtrlC();
    await exit(resumed.setup);
    expect(await resumed.code).toBe(0);
  });
});

describe("TuiApp multi-window projection", () => {
  test("two TUIs consuming one session event stream show the same server transcript", async () => {
    const first = await start();
    const second = await start();
    const accepted = {
      type: "turn.accepted" as const,
      sessionId,
      sessionSequence: 1,
      turnId,
      runId,
      clientMessageId: "850e8400-e29b-41d4-a716-446655440002",
      userMessage: "shared message",
    };
    first.controller.emit(accepted);
    second.controller.emit(accepted);
    await first.setup.waitForFrame((frame) => frame.includes("[YOU] shared message"));
    await second.setup.waitForFrame((frame) => frame.includes("[YOU] shared message"));
    first.controller.emit({
      type: "turn.committed",
      sessionId,
      sessionSequence: 2,
      turnId,
      runId,
      status: "succeeded",
      reason: "completed",
    });
    second.controller.emit({
      type: "turn.committed",
      sessionId,
      sessionSequence: 2,
      turnId,
      runId,
      status: "succeeded",
      reason: "completed",
    });
    await exit(first.setup);
    await exit(second.setup);
    expect(await first.code).toBe(0);
    expect(await second.code).toBe(0);
  });
});

describe("TuiApp launch and selector", () => {
  test("--continue selects newest resumable session and explicit mismatch is an error", async () => {
    const newer = {
      ...summary,
      sessionId: "650e8400-e29b-41d4-a716-446655440000",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    const resumed = await start({ kind: "continue" }, [summary, newer]);
    await resumed.setup.waitForFrame((frame) => frame.includes("650e8400"));
    await exit(resumed.setup);
    expect(await resumed.code).toBe(0);
    const wrong = { ...summary, workspaceRoot: "/other" };
    const mismatch = await start({ kind: "session", sessionId }, [wrong]);
    await mismatch.setup.waitForFrame((frame) => frame.includes("start mc-tui from"));
    await exit(mismatch.setup);
    expect(await mismatch.code).toBe(2);
  });
  test("no continue target is explicit, while selector keys toggle filters and reject corrupted", async () => {
    const missing = await start({ kind: "continue" }, []);
    await missing.setup.waitForFrame((frame) => frame.includes("no resumable session"));
    await exit(missing.setup);
    expect(await missing.code).toBe(2);
    const corrupted = { ...summary, status: "corrupted" as const };
    const selected = await start({ kind: "sessions" }, [corrupted]);
    selected.setup.mockInput.pressKey("o");
    selected.setup.mockInput.pressTab();
    selected.setup.mockInput.pressArrow("down");
    selected.setup.mockInput.pressEnter();
    await selected.setup.waitForFrame((frame) => frame.includes("corrupted"));
    selected.setup.mockInput.pressEscape();
    expect(await selected.code).toBe(0);
  });
});
