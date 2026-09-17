import { shortId, type TuiSnapshot } from "../model.ts";

/** 把 token 数压缩为适合终端底栏的稳定文本。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

/** 左下角上下文状态；used 是最近一次模型请求结束后的实际上下文占用。 */
export function formatContext(snapshot: TuiSnapshot): string {
  const used =
    snapshot.contextUsedTokens === undefined ? "--" : formatTokenCount(snapshot.contextUsedTokens);
  const limit =
    snapshot.contextWindowTokens === undefined
      ? "--"
      : formatTokenCount(snapshot.contextWindowTokens);
  const percent =
    snapshot.contextUsedTokens === undefined || snapshot.contextWindowTokens === undefined
      ? ""
      : ` ${Math.min(999.9, (snapshot.contextUsedTokens / snapshot.contextWindowTokens) * 100).toFixed(1)}%`;
  return `context ${used}/${limit}${percent}`;
}

/** 右下角当前模型；尚未收到模型事件时展示配置值或占位符。 */
export function formatModel(snapshot: TuiSnapshot): string {
  return snapshot.model === undefined || snapshot.model.length === 0 ? "model —" : snapshot.model;
}

/** workspace 行右侧保留精简连接/运行状态和必要提示。 */
export function formatRuntime(snapshot: TuiSnapshot): string {
  const session =
    snapshot.session === undefined
      ? "session --------"
      : `session ${shortId(snapshot.session.sessionId)}`;
  const notice = snapshot.notice === undefined ? "" : ` · ${snapshot.notice}`;
  return `${session} · ${snapshot.connection} · ${snapshot.readOnly ? "read-only" : snapshot.compacting ? "compacting" : snapshot.run}${notice}`;
}
