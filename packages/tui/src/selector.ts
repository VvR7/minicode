import type { SessionSummary } from "@minicode/protocol";

/** Session 选择页的纯本地状态。 */
export interface SelectorState {
  readonly sessions: readonly SessionSummary[];
  readonly selected: number;
  readonly allWorkspaces: boolean;
  readonly includeOneShot: boolean;
}
export type SelectorAction = "up" | "down" | "toggle-workspace" | "toggle-one-shot";

/** 创建默认选择页状态。 */
export function createSelectorState(): SelectorState {
  return { sessions: [], selected: 0, allWorkspaces: false, includeOneShot: false };
}
/** 按协议规定的 updatedAt 降序、sessionId 升序稳定排序。 */
export function sortSessions(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  return [...sessions].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}
/** 更新列表并把游标限制在有效范围。 */
export function setSelectorSessions(
  state: SelectorState,
  sessions: readonly SessionSummary[],
): SelectorState {
  const sorted = sortSessions(sessions);
  return {
    ...state,
    sessions: sorted,
    selected: Math.min(state.selected, Math.max(0, sorted.length - 1)),
  };
}
/** 应用选择页按键动作。 */
export function reduceSelector(state: SelectorState, action: SelectorAction): SelectorState {
  if (action === "toggle-workspace")
    return { ...state, allWorkspaces: !state.allWorkspaces, selected: 0 };
  if (action === "toggle-one-shot")
    return { ...state, includeOneShot: !state.includeOneShot, selected: 0 };
  if (state.sessions.length === 0) return state;
  const delta = action === "up" ? -1 : 1;
  return {
    ...state,
    selected: (state.selected + delta + state.sessions.length) % state.sessions.length,
  };
}
/** 判断条目能否从当前 workspace 进入；one_shot 只读但允许审计。 */
export function canOpenSession(session: SessionSummary, workspaceRoot: string): boolean {
  return session.status !== "corrupted" && session.workspaceRoot === workspaceRoot;
}
/** 生成选择页纯文本，标签保证无颜色模式仍可识别。 */
export function formatSelector(state: SelectorState, workspaceRoot: string): string {
  const header = `[SESSIONS] scope=${state.allWorkspaces ? "all" : "current"} one_shot=${state.includeOneShot ? "shown" : "hidden"}`;
  if (state.sessions.length === 0) return `${header}\n\nNo sessions found.`;
  return `${header}\n\n${state.sessions
    .map((session, index) => {
      const cursor = index === state.selected ? ">" : " ";
      const short = session.sessionId.slice(0, 8);
      const access =
        session.status === "corrupted"
          ? "ERROR corrupted"
          : session.workspaceRoot !== workspaceRoot
            ? "VIEW ONLY wrong workspace"
            : session.mode === "one_shot"
              ? "READ ONLY"
              : session.status;
      return `${cursor} ${session.title || "Untitled"}  ${short}  ${access}\n    ${session.workspaceRoot}  ${session.updatedAt}`;
    })
    .join("\n")}`;
}
