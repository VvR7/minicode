import { AgentRunParamsSchema } from "@minicode/protocol";

/** `mc-tui --goal <text>` 参数解析结果。 */
export type TuiArgsResult =
  | { readonly ok: true; readonly goal: string }
  | { readonly ok: false; readonly error: string };

/**
 * 解析 `mc-tui --goal <text>` 或 `mc-tui --goal=<text>`。
 * 只接受 --goal 一个选项，并用协议 schema 校验 goal 的长度边界。
 */
export function parseTuiArgs(args: readonly string[]): TuiArgsResult {
  let goal: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--goal") {
      const value = args[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--goal requires a value" };
      }
      goal = value;
      i += 1;
    } else if (arg.startsWith("--goal=")) {
      goal = arg.slice("--goal=".length);
    } else {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
  }
  if (goal === undefined) {
    return { ok: false, error: "missing required --goal" };
  }
  const parsed = AgentRunParamsSchema.shape.goal.safeParse(goal);
  if (!parsed.success) {
    return { ok: false, error: "--goal must be 1..32768 characters" };
  }
  return { ok: true, goal: parsed.data };
}
