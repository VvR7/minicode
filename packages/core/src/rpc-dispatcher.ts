import {
  JsonRpcErrorCode,
  JsonRpcRequestEnvelopeSchema,
  JSON_RPC_VERSION,
  makeJsonRpcError,
} from "@minicode/protocol";

import type { JsonRpcErrorResponse, JsonRpcSuccessEnvelope } from "@minicode/protocol";
import type { RpcMethodHandler } from "./handlers/rpc-method-handler.ts";

export type JsonRpcDispatchResult = JsonRpcSuccessEnvelope | JsonRpcErrorResponse;

export interface RpcDispatcherOptions {
  /** 所有已注册的 RPC 方法；一个 method 只能注册一个 handler。 */
  readonly handlers: readonly RpcMethodHandler[];
}

/** 将 handler 列表建立为按 method 查询的注册表，并及早发现重复注册的编程错误。 */
function createHandlerRegistry(
  handlers: readonly RpcMethodHandler[],
): ReadonlyMap<string, RpcMethodHandler> {
  const registry = new Map<string, RpcMethodHandler>();
  for (const handler of handlers) {
    if (registry.has(handler.method)) {
      throw new Error(`duplicate RPC handler registration: ${handler.method}`);
    }
    registry.set(handler.method, handler);
  }
  return registry;
}

/**
 * 创建与具体业务方法无关的 JSON-RPC dispatcher。
 * 它只校验 envelope、查找 handler、映射通用错误，并包装 JSON-RPC 响应。
 */
export function createRpcDispatcher(options: RpcDispatcherOptions) {
  const handlers = createHandlerRegistry(options.handlers);

  return async (value: unknown): Promise<JsonRpcDispatchResult> => {
    const envelope = JsonRpcRequestEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      return makeJsonRpcError(null, JsonRpcErrorCode.invalidRequest, "Invalid Request");
    }

    const handler = handlers.get(envelope.data.method);
    if (handler === undefined) {
      return makeJsonRpcError(
        envelope.data.id,
        JsonRpcErrorCode.methodNotFound,
        `Method not found: ${envelope.data.method}`,
      );
    }

    try {
      const result = await handler.invoke(envelope.data.params);
      if (result.kind === "invalid-params") {
        return makeJsonRpcError(envelope.data.id, JsonRpcErrorCode.invalidParams, "Invalid params");
      }

      return {
        jsonrpc: JSON_RPC_VERSION,
        id: envelope.data.id,
        result: result.result,
      };
    } catch {
      return makeJsonRpcError(envelope.data.id, JsonRpcErrorCode.internalError, "Internal error");
    }
  };
}
