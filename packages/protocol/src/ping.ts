import { z } from "zod";

import {
  JsonRpcErrorResponseSchema,
  JsonRpcIdSchema,
  JSON_RPC_VERSION,
  jsonRpcSuccessSchema,
} from "./json-rpc.ts";

export const CORE_PING_METHOD = "core.ping" as const;

export const PingParamsSchema = z.strictObject({
  clientName: z.string().min(1).max(128),
  clientVersion: z.string().min(1).max(64),
});
export type PingParams = z.infer<typeof PingParamsSchema>;

export const PingRequestSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.literal(CORE_PING_METHOD),
  params: PingParamsSchema,
});
export type PingRequest = z.infer<typeof PingRequestSchema>;

export const PongResultSchema = z.strictObject({
  serverVersion: z.string().min(1),
  uptimeMs: z.number().int().nonnegative(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type PongResult = z.infer<typeof PongResultSchema>;

export const PingSuccessResponseSchema = jsonRpcSuccessSchema(PongResultSchema);
export type PingSuccessResponse = z.infer<typeof PingSuccessResponseSchema>;

export const PingResponseSchema = z.union([PingSuccessResponseSchema, JsonRpcErrorResponseSchema]);
export type PingResponse = z.infer<typeof PingResponseSchema>;
