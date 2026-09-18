import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ClientPermission,
  SessionController,
  type SessionControllerConnector,
  type SessionControllerEvent,
} from "@minicode/client";
import {
  type CoreEndpoint,
  DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
  MAX_SESSION_MESSAGE_CHARS,
  type PermissionDecision,
  type PermissionRespondResult,
  type SessionListResult,
  type SessionSummary,
} from "@minicode/protocol";
import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";

import { TuiModel } from "./model.ts";
import type { TuiLaunchMode } from "./options.ts";
import {
  canOpenSession,
  createSelectorState,
  formatSelector,
  reduceSelector,
  type SelectorState,
  setSelectorSessions,
  sortSessions,
} from "./selector.ts";
import { formatContext, formatModel, formatRuntime } from "./widgets/chat-footer.ts";
import { EventLog } from "./widgets/event-log.ts";
import { formatChatHelp, SELECTOR_HELP } from "./widgets/help-bar.ts";
import { PERMISSION_CHOICES } from "./widgets/permission-block.ts";

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
  compact(focus?: string): Promise<import("@minicode/protocol").SessionCompactResult>;
  cancelActiveRun(): Promise<unknown>;
  respondPermission(
    runId: string,
    permissionRequestId: string,
    decision: PermissionDecision,
  ): Promise<PermissionRespondResult>;
  dispose(): Promise<void>;
}

export interface TuiAppOptions {
  readonly mode: TuiLaunchMode;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  readonly createRenderer?: RendererFactory;
  readonly connect?: SessionControllerConnector;
  readonly reconnectDelayMs?: number;
  /** 启动时先展示的模型配置，收到 Core 模型事件后由权威值覆盖。 */
  readonly model?: string;
  /** 启动时先展示的上下文上限，收到 Core usage 事件后由权威值覆盖。 */
  readonly contextWindowTokens?: number;
  /** 测试注入 controller；consumer 必须接收全部服务端事件。 */
  readonly createController?: (
    consumer: (event: SessionControllerEvent) => void,
    onPermissions: (permissions: readonly ClientPermission[]) => void,
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
    const model = new TuiModel({
      ...(options.model === undefined ? {} : { model: options.model }),
      contextWindowTokens: options.contextWindowTokens ?? DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
    });
    let controller: TuiSessionController | undefined;
    let screen: "chat" | "selector" = options.mode.kind === "sessions" ? "selector" : "chat";
    let selector: SelectorState = createSelectorState();
    let operationPending = false;
    let closing = false;
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
    const log = new EventLog(renderer);
    const selectorView = new TextRenderable(renderer, {
      id: "selector",
      content: "Loading sessions…",
      width: "100%",
      flexGrow: 1,
      wrapMode: "char",
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
      paddingX: 1,
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
    const inputFrame = new BoxRenderable(renderer, {
      id: "input-frame",
      width: "100%",
      height: 5,
      border: ["top", "bottom"],
      borderStyle: "single",
      borderColor: "#626880",
      focusedBorderColor: "#8caaee",
    });
    inputFrame.add(input);
    const workspaceRow = new BoxRenderable(renderer, {
      id: "workspace-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
    });
    const workspace = new TextRenderable(renderer, {
      id: "workspace",
      content: workspaceRoot,
      height: 1,
      flexGrow: 1,
      truncate: true,
      fg: "#c6d0f5",
    });
    const runtime = new TextRenderable(renderer, {
      id: "runtime",
      content: formatRuntime(model.snapshot()),
      height: 1,
      width: "auto",
      truncate: true,
      fg: "#838ba7",
    });
    workspaceRow.add(workspace);
    workspaceRow.add(runtime);
    const footerRow = new BoxRenderable(renderer, {
      id: "footer-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
    });
    const context = new TextRenderable(renderer, {
      id: "context",
      content: formatContext(model.snapshot()),
      height: 1,
      flexGrow: 1,
      fg: "#a6d189",
    });
    const currentModel = new TextRenderable(renderer, {
      id: "model",
      content: formatModel(model.snapshot()),
      height: 1,
      width: "auto",
      truncate: true,
      fg: "#8caaee",
    });
    footerRow.add(context);
    footerRow.add(currentModel);
    root.add(log.scrollbox);
    root.add(selectorView);
    root.add(inputFrame);
    root.add(workspaceRow);
    root.add(footerRow);
    root.add(help);
    renderer.root.add(root);

    /** 根据屏幕和模型状态刷新状态、帮助、计数与输入可见性。 */
    const updateChrome = (): void => {
      if (closing) return;
      const snapshot = model.snapshot();
      const length = input.plainText.length;
      const remaining = MAX_SESSION_MESSAGE_CHARS - length;
      selectorView.content = formatSelector(selector, workspaceRoot);
      help.content =
        screen === "selector" ? SELECTOR_HELP : formatChatHelp(snapshot.run, snapshot.readOnly);
      workspace.content = workspaceRoot;
      runtime.content = formatRuntime(snapshot);
      context.content =
        remaining >= 0
          ? formatContext(snapshot)
          : `draft ${-remaining} over limit · ${formatContext(snapshot)}`;
      context.fg = remaining >= 0 ? "#a6d189" : "#ff5555";
      currentModel.content = formatModel(snapshot);
      selectorView.visible = screen === "selector";
      log.scrollbox.visible = screen === "chat";
      inputFrame.visible = screen === "chat";
      workspaceRow.visible = screen === "chat";
      footerRow.visible = screen === "chat";
      help.visible = screen === "selector";
      if (
        inputFrame.visible &&
        snapshot.run === "idle" &&
        !snapshot.compacting &&
        !operationPending
      )
        input.focus();
      else input.blur();
    };

    /** 唯一 controller consumer：同步归约后增量刷新视图。 */
    const consume = (event: SessionControllerEvent): void => {
      if (closing) return;
      log.apply(model.apply(event));
      updateChrome();
    };
    /** 接收共享审批投影，补充 RPC 过期及重连后的 UI 状态。 */
    const consumePermissions = (entries: readonly ClientPermission[]): void => {
      if (closing) return;
      log.apply(model.syncPermissions(entries));
      updateChrome();
    };
    controller =
      options.createController?.(consume, consumePermissions) ??
      new SessionController({
        endpoint: options.endpoint,
        onEvent: consume,
        onPermissions: consumePermissions,
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

    /** 发送审批，不阻塞事件消费，也不乐观替换已决块。 */
    const respondPermission = (decision: PermissionDecision): void => {
      const permission = model.beginPermission(decision);
      if (permission === undefined || controller === undefined) return;
      const id = permission.request.payload.permissionRequestId;
      log.apply(model.syncPermissions([]));
      updateChrome();
      void controller
        .respondPermission(permission.request.runId, id, decision)
        .then((result) => {
          if (!closing) log.apply(model.finishPermission(id, result.outcome));
        })
        .catch(
          (error) =>
            !closing &&
            log.apply(
              model.finishPermission(
                id,
                undefined,
                error instanceof Error ? error.message : "approval failed",
              ),
            ),
        )
        .finally(updateChrome);
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

    /** 处理聊天提交与会话 slash command。 */
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
        if (snapshot.run !== "idle" || snapshot.compacting) {
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
      if (content === "/compact" || content.startsWith("/compact ")) {
        if (snapshot.run !== "idle" || snapshot.compacting) {
          model.setNotice("session is busy");
          updateChrome();
          return;
        }
        operationPending = true;
        input.clear();
        model.setNotice(undefined);
        updateChrome();
        try {
          const focus = content.slice("/compact".length).trim();
          const result = await controller.compact(focus || undefined);
          if (result.status === "unchanged") model.setNotice("context does not need compaction");
        } catch (error) {
          log.apply(model.addError(error instanceof Error ? error.message : "compaction failed"));
        } finally {
          operationPending = false;
          updateChrome();
        }
        return;
      }
      if (content === "/new") {
        if (snapshot.run !== "idle" || snapshot.compacting) {
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
      if (snapshot.run !== "idle" || snapshot.compacting) {
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
      } else if (snapshot.permission !== undefined && snapshot.run !== "cancelling") {
        key.preventDefault();
        if (key.ctrl || key.meta || key.option) return;
        if (key.name === "up" || key.name === "down" || key.name === "tab") {
          log.apply(
            model.movePermission(key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1),
          );
          updateChrome();
        } else if (["return", "enter", "kpenter"].includes(key.name))
          respondPermission(snapshot.permissionSelection);
        else {
          const index = (
            { "1": 0, y: 0, "2": 1, a: 1, "3": 2, n: 2, "4": 3, d: 3 } as Record<string, number>
          )[key.name];
          const decision = index === undefined ? undefined : PERMISSION_CHOICES[index];
          if (decision !== undefined) respondPermission(decision);
        }
      } else if (
        (snapshot.run !== "idle" || snapshot.compacting) &&
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
        (snapshot.run !== "idle" || snapshot.compacting || operationPending) &&
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
      closing = true;
      renderer.keyInput.off("keypress", onKeyPress);
      try {
        await controller.dispose();
      } finally {
        log.destroy();
        renderer.destroy();
      }
    }
  }
}
