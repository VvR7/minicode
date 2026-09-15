import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  type Renderable,
  type RenderContext,
  type ScrollUnit,
} from "@opentui/core";

import type { LogKind, LogLine, LogMutation } from "../model.ts";

/** 各日志类别对应的前景色；undefined 表示使用终端默认色。 */
export const LOG_KIND_COLORS: Record<LogKind, string | undefined> = {
  you: "#00ffff",
  assistant: undefined,
  turn: "#ff00ff",
  "task-pending": "#e5c07b",
  "task-running": "#61afef",
  "task-completed": "#98c379",
  "task-blocked": "#b8a46a",
  info: "#808080",
  error: "#ff5555",
  model: "#56b6c2",
  tool: "#98c379",
  "tool-error": "#e06c75",
  "tool-retry": "#e5c07b",
  retry: "#e5c07b",
  usage: "#5799a8",
};

/** 长文本的换行策略：assistant 按词、其余按字符，避免密集文本溢出。 */
function wrapModeFor(kind: LogKind): "none" | "char" | "word" {
  return kind === "assistant" ? "word" : "char";
}

/**
 * 可滚动事件日志：维护一个 ScrollBox 与按行号索引的 TextRenderable，
 * 把模型产出的 append/update/remove 变更增量应用到终端组件。
 */
export class EventLog {
  readonly scrollbox: ScrollBoxRenderable;
  #lines = new Map<
    number,
    { readonly root: Renderable; readonly content: TextRenderable | MarkdownRenderable }
  >();
  #ctx: RenderContext;
  #markdownStyle: SyntaxStyle;

  constructor(ctx: RenderContext) {
    this.#ctx = ctx;
    this.#markdownStyle = SyntaxStyle.fromStyles({
      default: { fg: "#c6d0f5" },
      "markup.heading": { fg: "#8caaee", bold: true },
      "markup.strong": { fg: "#e5c890", bold: true },
      "markup.italic": { fg: "#babbf1", italic: true },
      "markup.raw": { fg: "#a6d189" },
      "markup.link": { fg: "#85c1dc", underline: true },
      "markup.quote": { fg: "#a5adce", italic: true },
      comment: { fg: "#838ba7", italic: true },
      keyword: { fg: "#ca9ee6" },
      string: { fg: "#a6d189" },
    });
    this.scrollbox = new ScrollBoxRenderable(ctx, {
      id: "log",
      width: "100%",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
  }

  /** 应用一批模型变更，逐条更新终端组件。 */
  apply(mutations: readonly LogMutation[]): void {
    for (const mutation of mutations) {
      if (mutation.type === "append") {
        this.#append(mutation.line);
      } else if (mutation.type === "update") {
        this.#update(mutation.line);
      } else {
        this.#remove(mutation.ids);
      }
    }
  }

  /** 把日志滚动到底部。 */
  scrollToBottom(): void {
    this.scrollbox.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
  }

  /** 相对滚动；delta 为负表示向上，unit 默认按行。 */
  scrollBy(delta: number, unit?: ScrollUnit): void {
    this.scrollbox.scrollBy(delta, unit);
  }

  /** 清空 transcript 组件，用于 session 切换。 */
  clear(): void {
    this.#remove([...this.#lines.keys()]);
  }

  /** 释放 Markdown syntax style 的原生资源。 */
  destroy(): void {
    this.clear();
    this.#markdownStyle.destroy();
  }

  /** 新建一行并加入滚动容器。 */
  #append(line: LogLine): void {
    if (line.kind === "assistant") {
      const root = new BoxRenderable(this.#ctx, {
        width: "100%",
        flexDirection: "column",
        marginTop: 1,
        marginBottom: 1,
      });
      root.add(
        new TextRenderable(this.#ctx, {
          content: "ASSISTANT",
          height: 1,
          fg: "#8caaee",
        }),
      );
      const markdown = new MarkdownRenderable(this.#ctx, {
        content: "",
        syntaxStyle: this.#markdownStyle,
        streaming: true,
        width: "100%",
        conceal: true,
        tableOptions: { style: "columns", widthMode: "full", wrapMode: "word" },
      });
      root.add(markdown);
      this.#lines.set(line.id, { root, content: markdown });
      this.scrollbox.add(root);
      const content = this.#assistantContent(line.text);
      // 初次挂载统一走 streaming parser；OpenTUI 冷路径直接以 false 初始化会留下空正文。
      // 实时回复在 run.finished 的 update 中切到 false，历史内容保持稳定的完整 streaming block。
      markdown.content = content;
      return;
    }
    const fg = LOG_KIND_COLORS[line.kind];
    const child = new TextRenderable(this.#ctx, {
      content: line.text,
      ...(fg === undefined ? {} : { fg }),
      width: "100%",
      wrapMode: wrapModeFor(line.kind),
    });
    this.#lines.set(line.id, { root: child, content: child });
    this.scrollbox.add(child);
  }

  /** 更新已有行的文本（assistant 流式拼接）。 */
  #update(line: LogLine): void {
    const child = this.#lines.get(line.id);
    if (child !== undefined) {
      child.content.content =
        child.content instanceof MarkdownRenderable ? this.#assistantContent(line.text) : line.text;
      if (child.content instanceof MarkdownRenderable)
        child.content.streaming = line.streaming ?? false;
      const fg = LOG_KIND_COLORS[line.kind];
      if (fg !== undefined && child.content instanceof TextRenderable) child.content.fg = fg;
    }
  }

  /** 删除被裁剪掉的行并释放对应组件。 */
  #remove(ids: readonly number[]): void {
    for (const id of ids) {
      const child = this.#lines.get(id);
      if (child === undefined) {
        continue;
      }
      this.scrollbox.remove(child.root);
      child.root.destroyRecursively();
      this.#lines.delete(id);
    }
  }

  /** Markdown 组件不显示 transcript 的稳定语义标签。 */
  #assistantContent(text: string): string {
    return text.replace(/^\[ASSISTANT\]\s?/u, "");
  }
}
