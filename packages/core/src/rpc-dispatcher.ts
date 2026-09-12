import {
  CORE_PING_METHOD,
  JsonRpcErrorCode,
  JsonRpcRequestEnvelopeSchema,
  JSON_RPC_VERSION,
  makeJsonRpcError,
  MINICODE_VERSION,
  PingParamsSchema,
} from "@minicode/protocol";

import type { JsonRpcErrorResponse, JsonRpcSuccessEnvelope } from "@minicode/protocol";

export type JsonRpcDispatchResult = JsonRpcSuccessEnvelope | JsonRpcErrorResponse;

export interface RpcDispatcherOptions {
  readonly uptimeMs: () => number;
  readonly now?: () => Date;
}

export function createRpcDispatcher(options: RpcDispatcherOptions) {
  const now = options.now ?? (() => new Date());

  return async (value: unknown): Promise<JsonRpcDispatchResult> => {
    const envelope = JsonRpcRequestEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      return makeJsonRpcError(null, JsonRpcErrorCode.invalidRequest, "Invalid Request");
    }

    if (envelope.data.method !== CORE_PING_METHOD) {
      return makeJsonRpcError(
        envelope.data.id,
        JsonRpcErrorCode.methodNotFound,
        `Method not found: ${envelope.data.method}`,
      );
    }

    const params = PingParamsSchema.safeParse(envelope.data.params);
    if (!params.success) {
      return makeJsonRpcError(envelope.data.id, JsonRpcErrorCode.invalidParams, "Invalid params");
    }

    return {
      jsonrpc: JSON_RPC_VERSION,
      id: envelope.data.id,
      result: {
        serverVersion: MINICODE_VERSION,
        uptimeMs: Math.max(0, Math.floor(options.uptimeMs())),
        receivedAt: now().toISOString(),
      },
    };
  };
}
