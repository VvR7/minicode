import type { AgentRunResult } from "@minicode/protocol";
import { AGENT_RUN_METHOD, AgentRunParamsSchema } from "@minicode/protocol";
import type { IpcEventBroadcaster } from "../events/ipc-event-broadcaster.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import type { RunManager } from "../run/manager.ts";
import type { RpcMethodInvocation } from "./rpc-method-handler.ts";
import { RpcMethodHandler } from "./rpc-method-handler.ts";

export interface AgentRunHandlerOptions {
  readonly manager: RunManager;
  readonly broadcaster: IpcEventBroadcaster;
}

/**
 * agent.run：生成 session/run、为来源连接建立 exact-run subscription、
 * 启动后台 run，并保证 response 严格早于首个事件（subscription 暂停到响应入队后）。
 */
export class AgentRunHandler extends RpcMethodHandler {
  readonly method = AGENT_RUN_METHOD;
  readonly #manager: RunManager;
  readonly #broadcaster: IpcEventBroadcaster;

  constructor(options: AgentRunHandlerOptions) {
    super();
    this.#manager = options.manager;
    this.#broadcaster = options.broadcaster;
  }

  async invoke(rawParams: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation> {
    const params = AgentRunParamsSchema.safeParse(rawParams);
    if (!params.success) {
      return { kind: "invalid-params" };
    }

    const sessionId = this.#manager.newSessionId();
    const runId = this.#manager.newRunId();

    const subscribed = await this.#broadcaster.subscribe(context.connection, sessionId, runId, 0);
    if (!subscribed.ok) {
      // dispatcher 会把该错误映射为标准 internal error，不泄露持久化细节。
      throw new Error(subscribed.error.code);
    }

    try {
      const activateRun = await this.#manager.start({
        sessionId,
        runId,
        goal: params.data.goal,
        workspaceRoot: params.data.workspaceRoot,
      });
      const activateSubscription = subscribed.value.afterResponseEnqueued;
      const result: AgentRunResult = {
        status: "accepted",
        sessionId,
        runId,
        subscriptionId: subscribed.value.result.subscriptionId,
      };
      return {
        kind: "success",
        result,
        afterResponseEnqueued: () => {
          activateSubscription();
          activateRun();
        },
      };
    } catch (error) {
      this.#broadcaster.unsubscribe(context.connection, subscribed.value.result.subscriptionId);
      throw error;
    }
  }
}
