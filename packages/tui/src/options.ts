import { MAX_SESSION_MESSAGE_CHARS, SessionIdSchema } from "@minicode/protocol";

/** 五种互斥启动模式。 */
export type TuiLaunchMode =
  | { readonly kind: "new"; readonly goal?: string }
  | { readonly kind: "continue" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "sessions" };

/** TUI 参数解析结果。 */
export type TuiArgsResult =
  | { readonly ok: true; readonly mode: TuiLaunchMode }
  | { readonly ok: false; readonly error: string };

/** 解析 mc-tui 的互斥启动选项；无参数即创建新 chat。 */
export function parseTuiArgs(args: readonly string[]): TuiArgsResult {
  if (args.length === 0) return { ok: true, mode: { kind: "new" } };
  if (args.length === 1 && args[0] === "--continue")
    return { ok: true, mode: { kind: "continue" } };
  if (args.length === 1 && args[0] === "--sessions")
    return { ok: true, mode: { kind: "sessions" } };
  let value: string | undefined;
  let option: "goal" | "session" | undefined;
  if (args.length === 2 && (args[0] === "--goal" || args[0] === "--session")) {
    option = args[0] === "--goal" ? "goal" : "session";
    value = args[1];
  } else if (args.length === 1 && args[0]?.startsWith("--goal=")) {
    option = "goal";
    value = args[0].slice(7);
  } else if (args.length === 1 && args[0]?.startsWith("--session=")) {
    option = "session";
    value = args[0].slice(10);
  } else return { ok: false, error: `unexpected or conflicting arguments: ${args.join(" ")}` };
  if (option === "session") {
    const parsed = SessionIdSchema.safeParse(value);
    return parsed.success
      ? { ok: true, mode: { kind: "session", sessionId: parsed.data } }
      : { ok: false, error: "--session requires a valid session ID" };
  }
  const goal = value?.trim() ?? "";
  if (goal.length === 0 || goal.length > MAX_SESSION_MESSAGE_CHARS)
    return { ok: false, error: `--goal must be 1..${MAX_SESSION_MESSAGE_CHARS} characters` };
  return { ok: true, mode: { kind: "new", goal } };
}
