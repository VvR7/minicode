import type { RunState } from "../model.ts";

/** 根据聊天状态只展示当前可用操作。 */
export function formatChatHelp(run: RunState, readOnly: boolean): string {
  if (readOnly) return "read-only audit  /exit exit  PgUp/PgDn scroll";
  if (run === "running" || run === "cancelling") return "Ctrl+C cancel  PgUp/PgDn scroll";
  return "Enter send  Ctrl+Enter newline  /new new chat  /exit exit";
}

/** 选择页固定帮助栏。 */
export const SELECTOR_HELP = "↑/↓ or j/k select  Enter open  Tab scope  O one_shot  Esc exit";
