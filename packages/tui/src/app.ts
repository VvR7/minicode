import {
  BoxRenderable,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import {
  SessionController,
  type SessionControllerConnector,
  type SessionControllerEvent,
} from "@minicode/client";
import {
  MAX_SESSION_MESSAGE_CHARS,
  type CoreEndpoint,
  type SessionListResult,
  type SessionSummary,
} from "@minicode/protocol";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { TuiModel } from "./model.ts";
import type { TuiLaunchMode } from "./options.ts";
import {
  canOpenSession,
  createSelectorState,
  formatSelector,
  reduceSelector,
  setSelectorSessions,
  sortSessions,
  type SelectorState,
} from "./selector.ts";
import { EventLog } from "./widgets/event-log.ts";
import { formatChatHelp, SELECTOR_HELP } from "./widgets/help-bar.ts";
import { formatStatus } from "./widgets/status-bar.ts";

/** 渲染器工厂：真实终端走 createCliRenderer，测试可注入 headless renderer。 */
export type RendererFactory = () => Promise<CliRenderer>;

/** TUI 仅依赖 SessionController 的公开门面，测试可替换为内存实现。 */
export interface TuiSessionController {
  create(workspaceRoot: string): Promise<SessionSummary>;
  attach(sessionId: string): Promise<void>;
  list(options?: {
    readonly workspaceRoot?: string;
    readonly includeOneShot?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<SessionListResult>;
  sendMessage(content: string): Promise<unknown>;
  cancelActiveRun(): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface TuiAppOptions {
  readonly mode: TuiLaunchMode;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  readonly createRenderer?: RendererFactory;
  readonly connect?: SessionControllerConnector;
  readonly reconnectDelayMs?: number;
  /** 测试注入 controller；consumer 必须接收全部服务端事件。 */
  readonly createController?: (
    consumer: (event: SessionControllerEvent) => void,
  ) => TuiSessionController;
}

/** 规范化启动 workspace，用于恢复权限判断和 session.list 过滤。 */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** 拉取全部分页结果，选择页和显式 session 校验不会被默认 50 条截断。 */
async function listAll(
  controller: TuiSessionController,
  options: { workspaceRoot?: string; includeOneShot: boolean },
): Promise<readonly SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await controller.list({
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    });
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return sortSessions(sessions);
}

/** 多轮 TUI：负责启动模式、选择页、输入状态机及 controller/renderer 生命周期。 */
export class TuiApp {
  /** 运行到 `/exit` 或选择页 Esc，正常交互退出为 0，启动错误为 2。 */
  async run(options: TuiAppOptions): Promise<number> {
    const renderer = await (
      options.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }))
    )();
    const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
    const model = new TuiModel();
    let controller: TuiSessionController | undefined;
    let screen: "chat" | "selector" = options.mode.kind === "sessions" ? "selector" : "chat";
    let selector: SelectorState = createSelectorState();
    let operationPending = false;
    let exitCode = 0;
    let resolveQuit: (() => void) | undefined;
    const quit = new Promise<void>((resolveQuitPromise) => {
      resolveQuit = resolveQuitPromise;
    });

    const root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
    const status = new TextRenderable(renderer, {
      id: "status",
      content: formatStatus(model.snapshot()),
      height: 1,
      width: "100%",
      bg: "#414559",
      fg: "#c6d0f5",
    });
    const log = new EventLog(renderer);
    const selectorView = new TextRenderable(renderer, {
      id: "selector",
      content: "Loading sessions…",
      width: "100%",
      flexGrow: 1,
      wrapMode: "char",
    });
    const counter = new TextRenderable(renderer, {
      id: "counter",
      content: `${MAX_SESSION_MESSAGE_CHARS} remaining`,
      height: 1,
      width: "100%",
      fg: "#838ba7",
    });
    const help = new TextRenderable(renderer, {
      id: "help",
      content: "",
      height: 1,
      width: "100%",
      fg: "#838ba7",
    });
    const input = new TextareaRenderable(renderer, {
      id: "input",
      width: "100%",
      height: 3,
      placeholder: "Ask minicode…",
      wrapMode: "word",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "return", ctrl: true, action: "newline" },
        { name: "kpenter", ctrl: true, action: "newline" },
      ],
      onContentChange: () => updateChrome(),
      onSubmit: () => {
        void submitInput();
      },
    });
    root.add(status);
    root.add(log.scrollbox);
    root.add(selectorView);
    root.add(input);
    root.add(counter);
    root.add(help);
    renderer.root.add(root);

    /** 根据屏幕和模型状态刷新状态、帮助、计数与输入可见性。 */
    const updateChrome = (): void => {
      const snapshot = model.snapshot();
      const length = input.plainText.length;
      const remaining = MAX_SESSION_MESSAGE_CHARS - length;
      status.content = formatStatus(snapshot);
      selectorView.content = formatSelector(selector, workspaceRoot);
      help.content =
        screen === "selector" ? SELECTOR_HELP : formatChatHelp(snapshot.run, snapshot.readOnly);
      counter.content = remaining >= 0 ? `${remaining} remaining` : `${-remaining} over limit`;
      counter.fg = remaining >= 0 ? "#838ba7" : "#ff5555";
      selectorView.visible = screen === "selector";
      log.scrollbox.visible = screen === "chat";
      input.visible = screen === "chat";
      counter.visible = input.visible && !snapshot.readOnly;
      if (input.visible && snapshot.run === "idle" && !operationPending) input.focus();
      else input.blur();
    };

    /** 唯一 controller consumer：同步归约后增量刷新视图。 */
    const consume = (event: SessionControllerEvent): void => {
      log.apply(model.apply(event));
      updateChrome();
    };
    controller =
      options.createController?.(consume) ??
      new SessionController({
        endpoint: options.endpoint,
        onEvent: consume,
        ...(options.connect === undefined ? {} : { connect: options.connect }),
        ...(options.reconnectDelayMs === undefined
          ? {}
          : { reconnectDelayMs: options.reconnectDelayMs }),
      });

    /** 清空旧归约状态，再附着目标 session。 */
    const openSession = async (session: SessionSummary): Promise<void> => {
      if (session.status === "corrupted")
        throw new Error(`session ${session.sessionId} is corrupted`);
      if (session.workspaceRoot !== workspaceRoot)
        throw new Error(
          `session belongs to ${session.workspaceRoot}; start mc-tui from that directory`,
        );
      // 先释放旧订阅，确认不会再有旧 session 事件进入 reducer 后才清空视图。
      await controller?.dispose();
      log.apply(model.reset(session.mode === "one_shot"));
      screen = "chat";
      updateChrome();
      await controller?.attach(session.sessionId);
      updateChrome();
    };

    /** 按当前选择页过滤开关重新分页加载。 */
    const reloadSelector = async (): Promise<void> => {
      if (controller === undefined) return;
      operationPending = true;
      updateChrome();
      try {
        const sessions = await listAll(controller, {
          ...(selector.allWorkspaces ? {} : { workspaceRoot }),
          includeOneShot: selector.includeOneShot,
        });
        selector = setSelectorSessions(selector, sessions);
        model.setNotice(undefined);
      } catch (error) {
        model.setNotice(error instanceof Error ? error.message : "failed to list sessions");
      } finally {
        operationPending = false;
        updateChrome();
      }
    };

    /** 处理聊天提交及两个本地 slash command。 */
    const submitInput = async (): Promise<void> => {
      if (controller === undefined || operationPending) return;
      const raw = input.plainText;
      const content = raw.trim();
      const snapshot = model.snapshot();
      if (content.length === 0) {
        model.setNotice("empty message was not sent");
        updateChrome();
        return;
      }
      if (content.length > MAX_SESSION_MESSAGE_CHARS) {
        model.setNotice(`message exceeds ${MAX_SESSION_MESSAGE_CHARS} characters`);
        updateChrome();
        return;
      }
      if (content === "/exit") {
        if (snapshot.run !== "idle") {
          model.setNotice("run is active; press Ctrl+C to cancel first");
          updateChrome();
          return;
        }
        input.clear();
        resolveQuit?.();
        return;
      }
      if (snapshot.readOnly) {
        model.setNotice("this session is read-only");
        updateChrome();
        return;
      }
      if (content === "/new") {
        if (snapshot.run !== "idle") {
          model.setNotice("cannot create a new session while running");
          updateChrome();
          return;
        }
        operationPending = true;
        input.clear();
        updateChrome();
        try {
          // 与显式切换使用相同顺序：旧订阅释放完成后再清空并创建新 session。
          await controller.dispose();
          log.apply(model.reset());
          await controller.create(workspaceRoot);
          model.setNotice("new session created");
        } catch (error) {
          log.apply(
            model.addError(error instanceof Error ? error.message : "failed to create session"),
          );
        } finally {
          operationPending = false;
          updateChrome();
        }
        return;
      }
      if (snapshot.run !== "idle") {
        model.setNotice("session is busy");
        updateChrome();
        return;
      }
      operationPending = true;
      model.setNotice(undefined);
      updateChrome();
      try {
        await controller.sendMessage(content);
        input.clear();
      } catch (error) {
        log.apply(
          model.addError(error instanceof Error ? error.message : "message was not accepted"),
        );
      } finally {
        operationPending = false;
        updateChrome();
      }
    };

    /** 全局按键仅处理屏幕级操作；普通字符（包括 q）留给 Textarea。 */
    const onKeyPress = (key: KeyEvent): void => {
      if (screen === "selector") {
        key.preventDefault();
        if (key.name === "escape") {
          resolveQuit?.();
          return;
        }
        if (operationPending) return;
        if (key.name === "up" || key.name === "k" || key.name === "down" || key.name === "j") {
          selector = reduceSelector(
            selector,
            key.name === "up" || key.name === "k" ? "up" : "down",
          );
          updateChrome();
          return;
        }
        if (key.name === "tab" || key.name === "o" || key.name === "O") {
          selector = reduceSelector(
            selector,
            key.name === "tab" ? "toggle-workspace" : "toggle-one-shot",
          );
          void reloadSelector();
          return;
        }
        if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
          const selected = selector.sessions[selector.selected];
          if (selected === undefined) {
            model.setNotice("no session selected");
            updateChrome();
          } else if (!canOpenSession(selected, workspaceRoot)) {
            model.setNotice(
              selected.status === "corrupted"
                ? `session ${selected.sessionId} is corrupted`
                : `switch to ${selected.workspaceRoot} to resume`,
            );
            updateChrome();
          } else {
            operationPending = true;
            void openSession(selected)
              .catch((error) =>
                log.apply(
                  model.addError(error instanceof Error ? error.message : "failed to open session"),
                ),
              )
              .finally(() => {
                operationPending = false;
                updateChrome();
              });
          }
        }
        return;
      }
      const snapshot = model.snapshot();
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        if (input.plainText.length > 0) {
          input.clear();
          model.setNotice("draft cleared");
          updateChrome();
        } else if (snapshot.run === "running") {
          model.markCancelling();
          model.setNotice("cancelling active run…");
          updateChrome();
          void controller?.cancelActiveRun().catch((error) => {
            model.setNotice(error instanceof Error ? error.message : "cancel failed");
            updateChrome();
          });
        } else if (snapshot.run === "cancelling") {
          model.setNotice("cancellation already requested");
          updateChrome();
        } else {
          model.setNotice("type /exit to leave");
          updateChrome();
        }
        return;
      }
      if (key.name === "pageup") {
        key.preventDefault();
        log.scrollBy(-1, "viewport");
      } else if (key.name === "pagedown") {
        key.preventDefault();
        log.scrollBy(1, "viewport");
      } else if (key.name === "home" && key.ctrl) {
        key.preventDefault();
        log.scrollbox.scrollTo({ x: 0, y: 0 });
      } else if (key.name === "end" && key.ctrl) {
        key.preventDefault();
        log.scrollToBottom();
      } else if (
        snapshot.run !== "idle" &&
        (key.name === "return" || key.name === "enter" || key.name === "kpenter")
      ) {
        key.preventDefault();
        model.setNotice(
          input.plainText.trim() === "/exit"
            ? "run is active; press Ctrl+C to cancel first"
            : "session is busy",
        );
        updateChrome();
      } else if (
        (snapshot.run !== "idle" || operationPending) &&
        !(key.ctrl && key.name === "return")
      )
        key.preventDefault();
    };
    renderer.keyInput.on("keypress", onKeyPress);

    try {
      updateChrome();
      try {
        const mode = options.mode;
        if (mode.kind === "sessions") await reloadSelector();
        else if (mode.kind === "new") {
          await controller.create(workspaceRoot);
          if (mode.goal !== undefined) {
            input.setText(mode.goal);
            await submitInput();
          }
        } else {
          const sessions = await listAll(controller, {
            ...(mode.kind === "continue" ? { workspaceRoot } : {}),
            includeOneShot: mode.kind === "session",
          });
          const target =
            mode.kind === "continue"
              ? sessions.find(
                  (session) => session.mode === "chat" && session.status !== "corrupted",
                )
              : sessions.find((session) => session.sessionId === mode.sessionId);
          if (target === undefined)
            throw new Error(
              mode.kind === "continue"
                ? "no resumable session exists for this workspace"
                : `session ${mode.sessionId} was not found`,
            );
          await openSession(target);
        }
      } catch (error) {
        exitCode = 2;
        log.apply(model.addError(error instanceof Error ? error.message : "failed to start TUI"));
        model.setNotice("type /exit to leave");
        updateChrome();
      }
      await quit;
      return exitCode;
    } finally {
      renderer.keyInput.off("keypress", onKeyPress);
      try {
        await controller.dispose();
      } finally {
        renderer.destroy();
      }
    }
  }
}
