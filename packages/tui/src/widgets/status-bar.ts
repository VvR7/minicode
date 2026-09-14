import { shortId, type TuiSnapshot } from "../model.ts";

/**
 * 根据模型快照生成单行状态栏文本。
 * 只产出纯文本，不包含颜色与终端控制序列，便于单元测试。
 */
export function formatStatus(snapshot: TuiSnapshot): string {
  const { connection, run, runId } = snapshot;
  const id = runId === undefined ? "" : `run ${shortId(runId)}  `;

  if (run.status === "finished") {
    const mark = run.outcome === "succeeded" ? "✓" : run.outcome === "cancelled" ? "⊘" : "✗";
    return `${id}${mark} ${run.outcome}`;
  }

  if (run.status === "client-error") {
    return `${id}✗ ${run.kind}`;
  }

  if (run.status === "running") {
    const state =
      connection === "connected"
        ? "running"
        : connection === "cancelling"
          ? "cancelling…"
          : "reconnecting…";
    return `${id}${state}`;
  }

  // 尚未收到 run.started：仅显示连接阶段。
  switch (connection) {
    case "connecting":
      return "connecting…";
    case "connected":
      return "connected — starting run";
    case "disconnected":
      return "disconnected — retrying";
    case "cancelling":
      return "cancelling…";
  }
}
