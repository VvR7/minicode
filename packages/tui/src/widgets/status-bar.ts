import { shortId, type TuiSnapshot } from "../model.ts";

/**
 * 根据模型快照生成单行状态栏文本。
 * 只产出纯文本，不包含颜色与终端控制序列，便于单元测试。
 */
export function formatStatus(snapshot: TuiSnapshot): string {
  const session =
    snapshot.session === undefined
      ? "session --------"
      : `session ${shortId(snapshot.session.sessionId)}`;
  const mode = snapshot.readOnly ? "read-only" : snapshot.run;
  const run = snapshot.activeRunId === undefined ? "" : `  run ${shortId(snapshot.activeRunId)}`;
  const notice = snapshot.notice === undefined ? "" : `  — ${snapshot.notice}`;
  return `${session}  ${mode}  ${snapshot.connection}${run}${notice}`;
}
