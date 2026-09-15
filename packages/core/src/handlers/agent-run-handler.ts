import type { AgentRunResult } from "@minicode/protocol";
import { AGENT_RUN_METHOD, AgentRunParamsSchema, JsonRpcErrorCode } from "@minicode/protocol";
import type { IpcEventBroadcaster } from "../events/ipc-event-broadcaster.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import type { SessionManager } from "../session/manager.ts";
import type { RpcMethodInvocation } from "./rpc-method-handler.ts";
import { RpcMethodHandler } from "./rpc-method-handler.ts";
import { sessionFailureInvocation } from "./session-handlers.ts";

export interface AgentRunHandlerOptions {
  readonly manager: SessionManager;
  readonly broadcaster: IpcEventBroadcaster;
}

/**
 * agent.run：生成 session/run、为来源连接建立 exact-run subscription、
 * 启动后台 run，并保证 response 严格早于首个事件（subscription 暂停到响应入队后）。
 */
export class AgentRunHandler extends RpcMethodHandler {
  readonly method = AGENT_RUN_METHOD;
  readonly #manager: SessionManager;
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

    const prepared = await this.#manager.prepareOneShot(
      params.data.workspaceRoot,
      params.data.goal,
    );
    if (!prepared.ok) {
      return sessionFailureInvocation(prepared.error);
    }
    const { sessionId, runId } = prepared.value.result;

    const subscribed = await this.#broadcaster.subscribe(context.connection, sessionId, runId, 0);
    if (!subscribed.ok) {
      const requestId = String(context.requestId ?? "unknown");
      prepared.value.recordRequest(
        context.connection.id,
        requestId,
        context.method ?? AGENT_RUN_METHOD,
        params.data,
      );
      // accepted 已持久化；错误响应入队或连接关闭后再运行，保持 response-before-event。
      void context.connection.closed.then(() => prepared.value.activate());
      return {
        kind: "error",
        code: JsonRpcErrorCode.internalError,
        message: "Internal error",
        afterResponseEnqueued: prepared.value.activate,
        afterResponseSent: (sent) =>
          prepared.value.recordResponseSent(context.connection.id, requestId, sent),
      };
    }

    try {
      const activateSubscription = subscribed.value.afterResponseEnqueued;
      const requestId = String(context.requestId ?? "unknown");
      prepared.value.recordRequest(
        context.connection.id,
        requestId,
        context.method ?? AGENT_RUN_METHOD,
        params.data,
      );
      // response 无法入队时连接会关闭；accepted run 仍继续。
      void context.connection.closed.then(() => prepared.value.activate());
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
          prepared.value.activate();
        },
        afterResponseSent: (sent) =>
          prepared.value.recordResponseSent(context.connection.id, requestId, sent),
      };
    } catch (error) {
      this.#broadcaster.unsubscribe(context.connection, subscribed.value.result.subscriptionId);
      throw error;
    }
  }
}
