import type { AgentRunResult } from "@minicode/protocol";
import { AGENT_RUN_METHOD, AgentRunParamsSchema } from "@minicode/protocol";
import type { IpcEventBroadcaster } from "../events/ipc-event-broadcaster.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import type { RunManager } from "../run/manager.ts";
import type { TraceService } from "../trace/service.ts";
import type { RpcMethodInvocation } from "./rpc-method-handler.ts";
import { RpcMethodHandler } from "./rpc-method-handler.ts";

export interface AgentRunHandlerOptions {
  readonly manager: RunManager;
  readonly broadcaster: IpcEventBroadcaster;
  readonly traceService?: TraceService;
}

/**
 * agent.run：生成 session/run、为来源连接建立 exact-run subscription、
 * 启动后台 run，并保证 response 严格早于首个事件（subscription 暂停到响应入队后）。
 */
export class AgentRunHandler extends RpcMethodHandler {
  readonly method = AGENT_RUN_METHOD;
  readonly #manager: RunManager;
  readonly #broadcaster: IpcEventBroadcaster;
  readonly #traceService: TraceService | undefined;

  constructor(options: AgentRunHandlerOptions) {
    super();
    this.#manager = options.manager;
    this.#broadcaster = options.broadcaster;
    this.#traceService = options.traceService;
  }

  async invoke(rawParams: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation> {
    const params = AgentRunParamsSchema.safeParse(rawParams);
    if (!params.success) {
      return { kind: "invalid-params" };
    }

    const sessionId = this.#manager.newSessionId();
    const runId = this.#manager.newRunId();
    const recorder = this.#traceService?.startRun(sessionId, runId, true);
    recorder?.record({
      source: "CLIENT",
      target: "CORE",
      kind: "ipc.request_received",
      connectionId: context.connection.id,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      data: {
        method: this.method,
        goal: params.data.goal,
        workspaceRoot: params.data.workspaceRoot,
      },
    });

    const subscribed = await this.#broadcaster.subscribe(context.connection, sessionId, runId, 0);
    if (!subscribed.ok) {
      recorder?.record({
        source: "CORE",
        target: "CLIENT",
        kind: "ipc.error",
        connectionId: context.connection.id,
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        data: { errorCode: subscribed.error.code },
      });
      await this.#traceService?.stopRun(sessionId, runId);
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
      // response 尚未入队连接就关闭时，订阅关闭负责放行 run；普通断连不取消执行。
      void subscribed.value.closed.then(() => activateRun());
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
          recorder?.record({
            source: "CORE",
            target: "CLIENT",
            kind: "ipc.response_queued",
            connectionId: context.connection.id,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            data: { status: "accepted" },
          });
          activateSubscription();
          activateRun();
        },
        afterResponseSent: (sent) => {
          recorder?.record({
            source: "CORE",
            target: "CLIENT",
            kind: sent ? "ipc.response_sent" : "ipc.error",
            connectionId: context.connection.id,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            data: sent ? { status: "sent" } : { errorCode: "connection_closed" },
          });
          void this.#traceService?.finishResponse(sessionId, runId);
        },
      };
    } catch (error) {
      this.#broadcaster.unsubscribe(context.connection, subscribed.value.result.subscriptionId);
      recorder?.record({
        source: "CORE",
        target: "CLIENT",
        kind: "ipc.error",
        connectionId: context.connection.id,
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        data: { errorCode: "run_start_failed" },
      });
      await this.#traceService?.stopRun(sessionId, runId);
      throw error;
    }
  }
}
