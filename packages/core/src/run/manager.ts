import type { AgentCancelResult, RunId, SessionId } from "@minicode/protocol";
import type { AgentRunRequest } from "./runner.ts";

/** RunManager 依赖的最小执行契约，测试可用 fake 替代真实 AgentRunner。 */
export interface RunExecutor {
  run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onStarted?: () => Promise<void>,
  ): Promise<void>;
}

interface ActiveRun {
  readonly activate: () => void;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/**
 * 管理全部 active run 的生命周期：生成标识、启动后台 task、
 * 幂等取消与 shutdown 时的统一取消。任何 run 的失败都已由
 * AgentRunner 收敛为 run.finished，这里只负责资源回收。
 */
export class RunManager {
  readonly #runner: RunExecutor;
  readonly #active = new Map<string, ActiveRun>();
  readonly #finished = new Set<string>();

  constructor(runner: RunExecutor) {
    this.#runner = runner;
  }

  newSessionId(): SessionId {
    return crypto.randomUUID() as SessionId;
  }

  newRunId(): RunId {
    return crypto.randomUUID() as RunId;
  }

  /** 启动后台 run；重复标识视为编程错误，立即抛出。 */
  start(request: AgentRunRequest): Promise<() => void> {
    const key = this.#key(request.sessionId, request.runId);
    if (this.#active.has(key) || this.#finished.has(key)) {
      throw new Error(`duplicate run: ${key}`);
    }
    const controller = new AbortController();
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    let didStart = false;
    let releaseRun!: () => void;
    const activation = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const promise = this.#runner.run(request, controller.signal, async () => {
      didStart = true;
      resolveStarted();
      await activation;
    });
    this.#active.set(key, {
      activate: releaseRun,
      controller,
      promise,
      sessionId: request.sessionId,
      runId: request.runId,
    });
    void promise.then(
      () => {
        if (!didStart) rejectStarted(new Error("run ended before durable start"));
      },
      (error) => rejectStarted(error),
    );
    const cleanup = (): void => {
      this.#active.delete(key);
      this.#finished.add(key);
    };
    // 同时处理成功与失败，避免 finally 派生出无人接管的 rejected Promise。
    void promise.then(cleanup, cleanup);
    return started.then(() => releaseRun);
  }

  /** 幂等取消：active 则 abort，已终态返回 already_finished，否则 not_found。 */
  cancel(sessionId: SessionId, runId: RunId): AgentCancelResult["outcome"] {
    const key = this.#key(sessionId, runId);
    const active = this.#active.get(key);
    if (active !== undefined) {
      active.activate();
      active.controller.abort();
      return "cancellation_requested";
    }
    if (this.#finished.has(key)) {
      return "already_finished";
    }
    return "not_found";
  }

  /** 取消全部 active run 并等待它们的 task 全部结束。 */
  async shutdown(): Promise<void> {
    const active = [...this.#active.values()];
    for (const run of active) {
      run.activate();
      run.controller.abort();
    }
    await Promise.allSettled(active.map((run) => run.promise));
  }

  get activeCount(): number {
    return this.#active.size;
  }

  #key(sessionId: SessionId, runId: RunId): string {
    return `${sessionId}:${runId}`;
  }
}
