import {
  ScrollBoxRenderable,
  TextRenderable,
  type RenderContext,
  type ScrollUnit,
} from "@opentui/core";

import type { LogKind, LogLine, LogMutation } from "../model.ts";

/** 各日志类别对应的前景色；undefined 表示使用终端默认色。 */
const KIND_COLORS: Record<LogKind, string | undefined> = {
  assistant: undefined,
  info: "#808080",
  "client-error": "#e06c75",
  model: "#56b6c2",
  tool: "#98c379",
  "tool-error": "#e06c75",
  retry: "#e5c07b",
  usage: "#808080",
  "run-ok": "#98c379",
  "run-fail": "#e06c75",
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
  #lines = new Map<number, TextRenderable>();
  #ctx: RenderContext;

  constructor(ctx: RenderContext) {
    this.#ctx = ctx;
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

  /** 新建一行并加入滚动容器。 */
  #append(line: LogLine): void {
    const fg = KIND_COLORS[line.kind];
    const child = new TextRenderable(this.#ctx, {
      content: line.text,
      ...(fg === undefined ? {} : { fg }),
      width: "100%",
      wrapMode: wrapModeFor(line.kind),
    });
    this.#lines.set(line.id, child);
    this.scrollbox.add(child);
  }

  /** 更新已有行的文本（assistant 流式拼接）。 */
  #update(line: LogLine): void {
    const child = this.#lines.get(line.id);
    if (child !== undefined) {
      child.content = line.text;
    }
  }

  /** 删除被裁剪掉的行并释放对应组件。 */
  #remove(ids: readonly number[]): void {
    for (const id of ids) {
      const child = this.#lines.get(id);
      if (child === undefined) {
        continue;
      }
      this.scrollbox.remove(child);
      child.destroy();
      this.#lines.delete(id);
    }
  }
}
