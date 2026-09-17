import {
  JsonRpcErrorCode,
  SESSION_CREATE_METHOD,
  SESSION_COMPACT_METHOD,
  SessionCompactParamsSchema,
  SESSION_GET_HISTORY_METHOD,
  SESSION_GET_METHOD,
  SESSION_LIST_METHOD,
  SESSION_SEND_MESSAGE_METHOD,
  SESSION_SUBSCRIBE_METHOD,
  SessionCreateParamsSchema,
  SessionGetHistoryParamsSchema,
  SessionGetParamsSchema,
  SessionListParamsSchema,
  SessionSendMessageParamsSchema,
  SessionSubscribeParamsSchema,
} from "@minicode/protocol";
import type { IpcSessionBroadcaster } from "../events/ipc-session-broadcaster.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import type {
  PreparedSessionRun,
  SessionManager,
  SessionManagerFailure,
} from "../session/manager.ts";
import type { RpcMethodInvocation } from "./rpc-method-handler.ts";
import { RpcMethodHandler } from "./rpc-method-handler.ts";

/** 把 SessionManager 的稳定错误映射为 JSON-RPC application error。 */
export function sessionFailureInvocation(error: SessionManagerFailure): RpcMethodInvocation {
  if (error.code === "invalid_params") {
    return { kind: "invalid-params" };
  }
  const code =
    error.code === "session_not_found"
      ? JsonRpcErrorCode.sessionNotFound
      : error.code === "session_busy"
        ? JsonRpcErrorCode.sessionBusy
        : error.code === "session_corrupted"
          ? JsonRpcErrorCode.sessionCorrupted
          : error.code === "context_limit_exceeded"
            ? JsonRpcErrorCode.contextLimitExceeded
            : error.code === "one_shot_not_resumable"
              ? JsonRpcErrorCode.oneShotNotResumable
              : JsonRpcErrorCode.internalError;
  const data = {
    ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
    ...(error.turnId === undefined ? {} : { turnId: error.turnId }),
    ...(error.runId === undefined ? {} : { runId: error.runId }),
  };
  return {
    kind: "error",
    code,
    message: error.message,
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
}

/** 为 prepared run 绑定请求、响应入队/发送 Trace 与断连继续执行语义。 */
function acceptedInvocation(
  prepared: PreparedSessionRun,
  context: RpcInvocationContext,
  params: unknown,
): RpcMethodInvocation {
  const requestId = String(context.requestId ?? "unknown");
  const method = context.method ?? SESSION_SEND_MESSAGE_METHOD;
  prepared.recordRequest(context.connection.id, requestId, method, params);
  // 响应无法入队时连接会关闭；已 accepted 的 run 仍必须继续。
  void context.connection.closed.then(() => prepared.activate());
  return {
    kind: "success",
    result: prepared.result,
    afterResponseEnqueued: prepared.activate,
    afterResponseSent: (sent) =>
      prepared.recordResponseSent(context.connection.id, requestId, sent),
  };
}

/** session.compact：空闲会话独立压缩，不创建普通 turn。 */
export class SessionCompactHandler extends RpcMethodHandler {
  readonly method = SESSION_COMPACT_METHOD;
  readonly paramsSchema = SessionCompactParamsSchema;
  readonly #manager: SessionManager;

  /** 保存会话编排依赖。 */
  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 校验 focus 并映射 busy、超窗与摘要失败。 */
  async invoke(rawParams: unknown): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const result = await this.#manager.compact(params.data.sessionId, params.data.focus);
    return result.ok
      ? { kind: "success", result: result.value }
      : sessionFailureInvocation(result.error);
  }
}

/** session.create：创建当前 workspace 的持久 chat session。 */
export class SessionCreateHandler extends RpcMethodHandler {
  readonly method = SESSION_CREATE_METHOD;
  readonly paramsSchema = SessionCreateParamsSchema;
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 校验后创建 session；业务错误交给自定义 invoke 映射。 */
  async invoke(rawParams: unknown): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const result = await this.#manager.create(params.data.workspaceRoot);
    return result.ok
      ? { kind: "success", result: { session: result.value } }
      : sessionFailureInvocation(result.error);
  }
}

/** session.get：读取单个 session 摘要。 */
export class SessionGetHandler extends RpcMethodHandler {
  readonly method = SESSION_GET_METHOD;
  readonly paramsSchema = SessionGetParamsSchema;
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 读取摘要并映射 application error。 */
  async invoke(rawParams: unknown): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const result = await this.#manager.get(params.data.sessionId);
    return result.ok
      ? { kind: "success", result: { session: result.value } }
      : sessionFailureInvocation(result.error);
  }
}

/** session.list：按 workspace/cursor 稳定分页。 */
export class SessionListHandler extends RpcMethodHandler {
  readonly method = SESSION_LIST_METHOD;
  readonly paramsSchema = SessionListParamsSchema;
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 列出 session 并保持协议默认值。 */
  async invoke(rawParams: unknown): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const result = await this.#manager.list({
      includeOneShot: params.data.includeOneShot,
      limit: params.data.limit,
      ...(params.data.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: params.data.workspaceRoot }),
      ...(params.data.cursor === undefined ? {} : { cursor: params.data.cursor }),
    });
    return result.ok
      ? { kind: "success", result: result.value }
      : sessionFailureInvocation(result.error);
  }
}

/** session.getHistory：返回审计历史及 session cursor。 */
export class SessionGetHistoryHandler extends RpcMethodHandler {
  readonly method = SESSION_GET_HISTORY_METHOD;
  readonly paramsSchema = SessionGetHistoryParamsSchema;
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 返回 history snapshot。 */
  async invoke(rawParams: unknown): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const result = await this.#manager.getHistory(params.data.sessionId);
    return result.ok
      ? { kind: "success", result: result.value }
      : sessionFailureInvocation(result.error);
  }
}

/** session.sendMessage：accepted 前完成幂等、busy 与预算检查。 */
export class SessionSendMessageHandler extends RpcMethodHandler {
  readonly method = SESSION_SEND_MESSAGE_METHOD;
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    super();
    this.#manager = manager;
  }

  /** 准备 run，并把实际启动延迟到 response 入队后。 */
  async invoke(rawParams: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation> {
    const params = SessionSendMessageParamsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const prepared = await this.#manager.prepareMessage(params.data);
    return prepared.ok
      ? acceptedInvocation(prepared.value, context, params.data)
      : sessionFailureInvocation(prepared.error);
  }
}

/** session.subscribe：建立 paused replay/live subscription 并返回 activeRun。 */
export class SessionSubscribeHandler extends RpcMethodHandler {
  readonly method = SESSION_SUBSCRIBE_METHOD;
  readonly #manager: SessionManager;
  readonly #broadcaster: IpcSessionBroadcaster;

  constructor(manager: SessionManager, broadcaster: IpcSessionBroadcaster) {
    super();
    this.#manager = manager;
    this.#broadcaster = broadcaster;
  }

  /** 原子接入 session event 流，响应入队前保持暂停。 */
  async invoke(rawParams: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation> {
    const params = SessionSubscribeParamsSchema.safeParse(rawParams);
    if (!params.success) return { kind: "invalid-params" };
    const session = await this.#manager.get(params.data.sessionId);
    if (!session.ok) return sessionFailureInvocation(session.error);
    const subscribed = await this.#broadcaster.subscribe(
      context.connection,
      params.data.sessionId,
      params.data.afterSequence,
    );
    if (!subscribed.ok) {
      return {
        kind: "error",
        code: JsonRpcErrorCode.internalError,
        message: "session subscription failed",
      };
    }
    return {
      kind: "success",
      result: {
        ...subscribed.value.result,
        ...(session.value.activeRun === undefined ? {} : { activeRun: session.value.activeRun }),
      },
      afterResponseEnqueued: subscribed.value.afterResponseEnqueued,
    };
  }
}
