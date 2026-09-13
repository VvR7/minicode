import { z } from "zod";

export const JSON_RPC_VERSION = "2.0" as const;

export const JsonRpcErrorCode = {
  runNotFound: -32001,
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;
export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

export const JsonRpcIdSchema = z.union([z.string().min(1), z.number().safe()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});
export type JsonRpcRequestEnvelope = z.infer<typeof JsonRpcRequestEnvelopeSchema>;

export function jsonRpcSuccessSchema<ResultSchema extends z.ZodType>(result: ResultSchema) {
  return z.strictObject({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: JsonRpcIdSchema,
    result,
  });
}

export const JsonRpcSuccessEnvelopeSchema = jsonRpcSuccessSchema(z.unknown());
export type JsonRpcSuccessEnvelope = z.infer<typeof JsonRpcSuccessEnvelopeSchema>;

export const JsonRpcErrorObjectSchema = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseEnvelopeSchema = z.union([
  JsonRpcSuccessEnvelopeSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponseEnvelope = z.infer<typeof JsonRpcResponseEnvelopeSchema>;

export const JsonRpcNotificationEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});
export type JsonRpcNotificationEnvelope = z.infer<typeof JsonRpcNotificationEnvelopeSchema>;

export function jsonRpcNotificationSchema<
  const Method extends string,
  ParamsSchema extends z.ZodType,
>(method: Method, params: ParamsSchema) {
  return z.strictObject({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    method: z.literal(method),
    params,
  });
}

export function makeJsonRpcError(
  id: JsonRpcId | null,
  code: JsonRpcErrorCode,
  message: string,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message },
  };
}
