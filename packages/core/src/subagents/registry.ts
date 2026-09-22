import type { RunId, SessionId } from "@minicode/protocol";
import { ToolError, type ToolOutput } from "../tools/types.ts";
export interface SubagentResult {
  readonly childRunId: RunId;
  readonly name: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly reason: string;
  readonly errorCode?: string;
  readonly steps: number;
  readonly content: string;
}
interface Entry {
  readonly background: boolean;
  readonly controller: AbortController;
  readonly settled: Promise<SubagentResult>;
  result?: SubagentResult;
  delivered: boolean;
}
/** 等待可取消且立即观察原 Promise 的拒绝，不自动重试子执行。 */
async function cancellable<T>(waiting: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ToolError("tool_cancelled", "subagent wait cancelled");
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new ToolError("tool_cancelled", "subagent wait cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void waiting.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** 一个父 run 独占的登记表，集中观察结果和控制恰好一次的上下文交付。 */
export class SubagentRegistry {
  readonly #sessionId: SessionId;
  readonly #parentRunId: RunId;
  readonly #entries = new Map<RunId, Entry>();
  #closed = false;
  /** 固定拥有者，其他 session 或父 run 无法查询该表。 */
  constructor(sessionId: SessionId, parentRunId: RunId) {
    this.#sessionId = sessionId;
    this.#parentRunId = parentRunId;
  }
  /** 立即安装成功和失败观察器；同步结果由对应工具交付，不再自动注入。 */
  register(
    childRunId: RunId,
    name: string,
    background: boolean,
    controller: AbortController,
    execution: Promise<SubagentResult>,
  ): void {
    if (this.#closed || this.#entries.has(childRunId))
      throw new Error("subagent registry unavailable");
    const settled = execution.then(
      (result) => result,
      (error) => ({
        childRunId,
        name,
        status:
          error instanceof ToolError && error.code === "tool_cancelled"
            ? ("cancelled" as const)
            : ("failed" as const),
        reason:
          error instanceof ToolError && error.code === "tool_cancelled"
            ? "cancelled"
            : "internal_error",
        ...(error instanceof ToolError ? { errorCode: error.code } : {}),
        steps: 0,
        content:
          error instanceof ToolError ? (error.output?.content ?? error.message) : "subagent failed",
      }),
    );
    const entry: Entry = { background, controller, settled, delivered: !background };
    this.#entries.set(childRunId, entry);
    void settled.then((result) => {
      entry.result = result;
    });
  }
  /** 查询运行中状态，或取消友好地等待终态；终态查询消费自动交付标记。 */
  async result(
    sessionId: SessionId,
    parentRunId: RunId,
    childRunId: RunId,
    wait: boolean,
    signal: AbortSignal,
  ): Promise<ToolOutput> {
    const entry = this.#entry(sessionId, parentRunId, childRunId);
    if (signal.aborted) throw new ToolError("tool_cancelled", "subagent query cancelled");
    const result = wait ? await cancellable(entry.settled, signal) : entry.result;
    if (!result) return { content: JSON.stringify({ childRunId, status: "running" }) };
    entry.delivered = true;
    const output = { content: JSON.stringify(result) };
    if (result.status !== "succeeded")
      throw new ToolError(
        result.status === "cancelled" ? "tool_cancelled" : "io_error",
        `subagent ${result.status}`,
        { output },
      );
    return output;
  }
  /** 在下一模型调用前收集完成结果，结束前等待剩余后台任务再交付。 */
  async deliver(wait: boolean, signal: AbortSignal): Promise<readonly string[]> {
    if (this.#closed) return [];
    if (wait)
      await cancellable(
        Promise.all(
          [...this.#entries.values()]
            .filter((entry) => entry.background && !entry.delivered)
            .map((entry) => entry.settled),
        ),
        signal,
      );
    if (signal.aborted) throw new ToolError("tool_cancelled", "subagent delivery cancelled");
    const results: string[] = [];
    for (const entry of this.#entries.values()) {
      if (!entry.background || entry.delivered || !entry.result) continue;
      entry.delivered = true;
      results.push(`Subagent result:\n${JSON.stringify(entry.result)}`);
    }
    return results;
  }
  /** 父失败、取消或停机时取消全部子任务，排空 Promise 后释放所有记录。 */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#entries.values()) entry.controller.abort();
    await Promise.allSettled([...this.#entries.values()].map((entry) => entry.settled));
    this.#entries.clear();
  }
  /** 验证归属并统一隐藏外国和未知子身份。 */
  #entry(sessionId: SessionId, parentRunId: RunId, childRunId: RunId): Entry {
    const entry = this.#entries.get(childRunId);
    if (
      this.#closed ||
      sessionId !== this.#sessionId ||
      parentRunId !== this.#parentRunId ||
      !entry
    )
      throw new ToolError("not_found", "subagent result unavailable");
    return entry;
  }
}
