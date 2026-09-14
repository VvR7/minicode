import {
  BoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { AgentRunClient, type AgentRunConnector } from "@minicode/client";
import type { CoreEndpoint } from "@minicode/protocol";

import { TuiModel, decideQuit } from "./model.ts";
import { HELP_BAR_TEXT } from "./widgets/help-bar.ts";
import { EventLog } from "./widgets/event-log.ts";
import { formatStatus } from "./widgets/status-bar.ts";

/** 渲染器工厂：真实终端走 createCliRenderer，测试注入 headless renderer。 */
export type RendererFactory = () => Promise<CliRenderer>;

export interface TuiAppOptions {
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  /** 渲染器工厂，默认连接真实终端。 */
  readonly createRenderer?: RendererFactory;
  /** 连接工厂，透传给共享客户端；测试注入 fake。 */
  readonly connect?: AgentRunConnector;
  /** 断线重连间隔毫秒数。 */
  readonly reconnectDelayMs?: number;
  /** 取消后等待 run.finished(cancelled) 的兜底超时毫秒数。 */
  readonly cancelTimeoutMs?: number;
}

/**
 * TUI 应用：组合 OpenTUI 渲染器、展示模型与共享 AgentRunClient。
 * 负责界面生命周期、键盘交互（滚动/取消/退出）与资源回收，退出码由 run 终态决定。
 */
export class TuiApp {
  /**
   * 运行 TUI 直到用户退出，返回进程退出码。
   * 运行期间后台启动 run 并流式渲染事件；退出时中止 run 并销毁渲染器恢复终端。
   */
  async run(options: TuiAppOptions): Promise<number> {
    const createRenderer =
      options.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }));
    const renderer = await createRenderer();

    try {
      const model = new TuiModel();

      // 三段式布局：状态栏 + 可滚动日志 + 快捷键提示。
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
      const help = new TextRenderable(renderer, {
        id: "help",
        content: HELP_BAR_TEXT,
        height: 1,
        width: "100%",
        fg: "#838ba7",
      });
      root.add(status);
      root.add(log.scrollbox);
      root.add(help);
      renderer.root.add(root);

      /** 状态/日志变化后刷新状态栏文本。 */
      const updateStatus = (): void => {
        status.content = formatStatus(model.snapshot());
      };

      const controller = new AbortController();
      let cancelRequested = false;
      let resolveQuit: ((code: number) => void) | undefined;
      const quit = new Promise<number>((resolve) => {
        resolveQuit = resolve;
      });

      /** 退出键处理：终态退出；运行中先取消；再次触发强制退出。 */
      const onQuitKey = (): void => {
        const decision = decideQuit(model.snapshot().run, cancelRequested);
        if (decision.action === "cancel") {
          cancelRequested = true;
          controller.abort();
          model.applyStatus({ state: "cancelling" });
          updateStatus();
          return;
        }
        resolveQuit?.(decision.code);
      };

      /** 全局键盘处理：退出键之外，映射滚动快捷键。 */
      const onKeyPress = (key: KeyEvent): void => {
        if (key.name === "q" || key.name === "Q" || (key.ctrl && key.name === "c")) {
          onQuitKey();
          return;
        }
        if (key.name === "up") {
          log.scrollBy(-1);
        } else if (key.name === "down") {
          log.scrollBy(1);
        } else if (key.name === "pageup") {
          log.scrollBy(-1, "viewport");
        } else if (key.name === "pagedown") {
          log.scrollBy(1, "viewport");
        } else if (key.name === "home") {
          log.scrollbox.scrollTo({ x: 0, y: 0 });
        } else if (key.name === "end") {
          log.scrollToBottom();
        }
      };
      renderer.keyInput.on("keypress", onKeyPress);

      const client = new AgentRunClient();
      // 后台 run：领域终态由事件归约；传输错误/取消超时由生命周期结果补成可退出状态。
      const clientRun = client.run(
        {
          goal: options.goal,
          workspaceRoot: options.workspaceRoot,
          endpoint: options.endpoint,
          signal: controller.signal,
          ...(options.connect === undefined ? {} : { connect: options.connect }),
          ...(options.reconnectDelayMs === undefined
            ? {}
            : { reconnectDelayMs: options.reconnectDelayMs }),
          initialConnectAttempts: Number.POSITIVE_INFINITY,
          ...(options.cancelTimeoutMs === undefined
            ? {}
            : { cancelTimeoutMs: options.cancelTimeoutMs }),
        },
        {
          onEvent: (event) => {
            log.apply(model.applyEvent(event));
            updateStatus();
          },
          onStatus: (status) => {
            model.applyStatus(status);
            updateStatus();
          },
        },
      );
      void clientRun.then((result) => {
        log.apply(model.applyClientResult(result));
        updateStatus();
      });

      const code = await quit;
      // 用户退出：先请求取消，再显式 shutdown 并等待 client 完成，确保 socket、listener、
      // cancel timer 都在 renderer/raw mode 销毁前释放。
      controller.abort();
      client.shutdown();
      await clientRun;
      renderer.keyInput.off("keypress", onKeyPress);
      return code;
    } finally {
      renderer.destroy();
    }
  }
}
