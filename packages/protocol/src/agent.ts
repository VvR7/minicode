import { z } from "zod";

import { JSON_RPC_VERSION, JsonRpcIdSchema, jsonRpcSuccessSchema } from "./json-rpc.ts";

export const AGENT_RUN_METHOD = "agent.run" as const;
export const AGENT_CANCEL_METHOD = "agent.cancel" as const;
export const EVENT_SUBSCRIBE_METHOD = "event.subscribe" as const;
export const EVENT_UNSUBSCRIBE_METHOD = "event.unsubscribe" as const;

export const SessionIdSchema = z.uuid();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const RunIdSchema = z.uuid();
export type RunId = z.infer<typeof RunIdSchema>;

export const SubscriptionIdSchema = z.uuid();
export type SubscriptionId = z.infer<typeof SubscriptionIdSchema>;

export const AgentRunParamsSchema = z.strictObject({
  goal: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024),
  workspaceRoot: z.string().min(1).max(4096),
});
export type AgentRunParams = z.infer<typeof AgentRunParamsSchema>;

export const AgentRunResultSchema = z.strictObject({
  status: z.literal("accepted"),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  subscriptionId: SubscriptionIdSchema,
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const AgentCancelParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
});
export type AgentCancelParams = z.infer<typeof AgentCancelParamsSchema>;

export const AgentCancelResultSchema = z.strictObject({
  outcome: z.enum(["cancellation_requested", "already_finished", "not_found"]),
});
export type AgentCancelResult = z.infer<typeof AgentCancelResultSchema>;

export const EventSubscribeParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  afterSequence: z.number().int().nonnegative().optional(),
});
export type EventSubscribeParams = z.infer<typeof EventSubscribeParamsSchema>;

export const EventSubscribeResultSchema = z.strictObject({
  subscriptionId: SubscriptionIdSchema,
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
});
export type EventSubscribeResult = z.infer<typeof EventSubscribeResultSchema>;

export const EventUnsubscribeParamsSchema = z.strictObject({
  subscriptionId: SubscriptionIdSchema,
});
export type EventUnsubscribeParams = z.infer<typeof EventUnsubscribeParamsSchema>;

export const EventUnsubscribeResultSchema = z.strictObject({
  removed: z.boolean(),
});
export type EventUnsubscribeResult = z.infer<typeof EventUnsubscribeResultSchema>;

function requestSchema<const Method extends string, ParamsSchema extends z.ZodType>(
  method: Method,
  params: ParamsSchema,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: JsonRpcIdSchema,
    method: z.literal(method),
    params,
  });
}

export const AgentRunRequestSchema = requestSchema(AGENT_RUN_METHOD, AgentRunParamsSchema);
export const AgentRunSuccessResponseSchema = jsonRpcSuccessSchema(AgentRunResultSchema);
export const AgentCancelRequestSchema = requestSchema(AGENT_CANCEL_METHOD, AgentCancelParamsSchema);
export const AgentCancelSuccessResponseSchema = jsonRpcSuccessSchema(AgentCancelResultSchema);
export const EventSubscribeRequestSchema = requestSchema(
  EVENT_SUBSCRIBE_METHOD,
  EventSubscribeParamsSchema,
);
export const EventSubscribeSuccessResponseSchema = jsonRpcSuccessSchema(EventSubscribeResultSchema);
export const EventUnsubscribeRequestSchema = requestSchema(
  EVENT_UNSUBSCRIBE_METHOD,
  EventUnsubscribeParamsSchema,
);
export const EventUnsubscribeSuccessResponseSchema = jsonRpcSuccessSchema(
  EventUnsubscribeResultSchema,
);
