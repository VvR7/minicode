import { z } from "zod";
import { RunIdSchema, SessionIdSchema, SubscriptionIdSchema } from "./agent.ts";
import { jsonRpcNotificationSchema } from "./json-rpc.ts";
import {
  PermissionDecisionSchema,
  PermissionRequestIdSchema,
  PermissionRequestSummarySchema,
  PermissionRiskCategorySchema,
  PermissionSourceSchema,
  ToolFailureCategorySchema,
} from "./permissions.ts";
import {
  SessionCompactionFailedEventSchema,
  SessionCompactionFinishedEventSchema,
  SessionCompactionStartedEventSchema,
  type SessionEvent,
  SessionTurnAcceptedEventSchema,
  SessionTurnFinishedEventSchema,
  TaskSnapshotSchema,
} from "./session.ts";

export const EVENT_PUSH_METHOD = "event.push" as const;

export const LlmUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

const EventBaseShape = {
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime({ offset: true }),
  durable: z.boolean(),
};

function eventSchema<
  const Type extends string,
  PayloadSchema extends z.ZodType,
  DurableSchema extends z.ZodType = z.ZodBoolean,
>(
  type: Type,
  payload: PayloadSchema,
  durable: DurableSchema = z.boolean() as unknown as DurableSchema,
) {
  return z.strictObject({ ...EventBaseShape, durable, type: z.literal(type), payload });
}

const ToolIdentityShape = {
  toolCallId: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
};

/** 子生命周期事件属于父 run；childRunId 只标识隔离执行，不替换信封 runId。 */
const SubagentIdentityShape = {
  childRunId: RunIdSchema,
  name: z.string().min(1).max(128),
  background: z.boolean(),
};

export const SubagentStartedEventSchema = eventSchema(
  "subagent.started",
  z.strictObject(SubagentIdentityShape),
  z.literal(true),
);
export const SubagentFinishedEventSchema = eventSchema(
  "subagent.finished",
  z.strictObject({
    ...SubagentIdentityShape,
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    summary: z.string().max(4096),
    errorCode: z.string().min(1).max(128).optional(),
  }),
  z.literal(true),
);

export const RunStartedEventSchema = eventSchema("run.started", z.strictObject({}));
export const StepStartedEventSchema = eventSchema(
  "step.started",
  z.strictObject({ step: z.number().int().positive() }),
);
export const LlmModelSelectedEventSchema = eventSchema(
  "llm.model_selected",
  z.strictObject({
    model: z.string().min(1).max(256),
    provider: z.string().min(1).max(64),
  }),
);
export const LlmTextDeltaEventSchema = eventSchema(
  "llm.text_delta",
  z.strictObject({
    text: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  z.literal(true),
);
export const LlmRetryingEventSchema = eventSchema(
  "llm.retrying",
  z.strictObject({
    attempt: z.number().int().min(2),
    maxAttempts: z.number().int().min(2),
    delayMs: z.number().int().nonnegative(),
    reason: z.enum(["network", "rate_limit", "unavailable"]),
  }),
  z.literal(true),
);
/** 单次 provider 调用用量；contextWindowTokens 可选以兼容已有持久事件。 */
export const LlmUsageEventSchema = eventSchema(
  "llm.usage",
  LlmUsageSchema.extend({ contextWindowTokens: z.number().int().positive().optional() }),
);
export const ToolStartedEventSchema = eventSchema(
  "tool.started",
  z.strictObject({
    ...ToolIdentityShape,
    attempt: z.number().int().positive(),
  }),
);
export const ToolRetryingEventSchema = eventSchema(
  "tool.retrying",
  z.union([
    // Stage2 持久事件不含 failureCategory，保留 legacy 分支用于重放。
    z.strictObject({
      ...ToolIdentityShape,
      attempt: z.number().int().min(2),
      maxAttempts: z.number().int().min(2),
      delayMs: z.number().int().nonnegative(),
      errorCode: z.string().min(1).max(128),
    }),
    z.strictObject({
      ...ToolIdentityShape,
      attempt: z.number().int().min(2),
      maxAttempts: z.number().int().min(2),
      delayMs: z.number().int().nonnegative(),
      failureCategory: ToolFailureCategorySchema,
      errorCode: z.string().min(1).max(128),
    }),
  ]),
  z.literal(true),
);
const LegacyToolFinishedPayloadSchema = z.strictObject({
  ...ToolIdentityShape,
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
const Stage3ToolFinishedPayloadSchema = z.discriminatedUnion("isError", [
  z.strictObject({
    ...ToolIdentityShape,
    isError: z.literal(false),
    durationMs: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    attempts: z.number().int().positive(),
    permissionSource: PermissionSourceSchema,
  }),
  z.strictObject({
    ...ToolIdentityShape,
    isError: z.literal(true),
    durationMs: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    attempts: z.number().int().nonnegative(),
    failureCategory: ToolFailureCategorySchema,
    errorCode: z.string().min(1).max(128),
    permissionSource: PermissionSourceSchema.optional(),
  }),
]);
export const ToolFinishedEventSchema = eventSchema(
  "tool.finished",
  z.union([LegacyToolFinishedPayloadSchema, Stage3ToolFinishedPayloadSchema]),
);
export const PermissionRequestedEventSchema = eventSchema(
  "permission.requested",
  z.strictObject({
    permissionRequestId: PermissionRequestIdSchema,
    ...ToolIdentityShape,
    childRunId: RunIdSchema.optional(),
    riskCategories: z.array(PermissionRiskCategorySchema).min(1).max(4),
    cacheable: z.boolean(),
    summary: PermissionRequestSummarySchema,
  }),
  z.literal(true),
);
export const PermissionResolvedEventSchema = eventSchema(
  "permission.resolved",
  z
    .strictObject({
      permissionRequestId: PermissionRequestIdSchema,
      ...ToolIdentityShape,
      childRunId: RunIdSchema.optional(),
      decision: PermissionDecisionSchema,
      allowed: z.boolean(),
      source: z.literal("user"),
    })
    .superRefine((payload, ctx) => {
      const shouldAllow = payload.decision === "allow_once" || payload.decision === "always_allow";
      if (payload.allowed !== shouldAllow) {
        ctx.addIssue({
          code: "custom",
          message: "allowed must match the permission decision",
          path: ["allowed"],
        });
      }
    }),
  z.literal(true),
);
export const StepFinishedEventSchema = eventSchema(
  "step.finished",
  z.strictObject({
    step: z.number().int().positive(),
    outcome: z.enum(["continue", "succeeded", "failed", "cancelled"]),
  }),
);

const TaskEventPayloadSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  task: TaskSnapshotSchema,
});

/** 任务创建事件；payload 包含 revision 与完整 TaskSnapshot。 */
export const TaskCreatedEventSchema = eventSchema("task.created", TaskEventPayloadSchema);
/** 任务更新事件；payload 包含 revision 与完整 TaskSnapshot。 */
export const TaskUpdatedEventSchema = eventSchema("task.updated", TaskEventPayloadSchema);

const RunResultShape = {
  finalText: z.string().max(256 * 1024),
  steps: z.number().int().nonnegative(),
  usage: LlmUsageSchema,
};

export const RunFinishedPayloadSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...RunResultShape,
    status: z.literal("succeeded"),
    reason: z.literal("completed"),
  }),
  z.strictObject({
    ...RunResultShape,
    status: z.literal("cancelled"),
    reason: z.literal("cancelled"),
  }),
  z.strictObject({
    ...RunResultShape,
    status: z.literal("failed"),
    reason: z.enum([
      "config_error",
      "llm_error",
      "max_steps",
      "run_timeout",
      "invalid_llm_response",
      "event_store_error",
      "session_store_error",
      "internal_error",
      "core_restarted",
    ]),
    error: z
      .strictObject({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(1024),
      })
      .optional(),
  }),
]);
export const RunFinishedEventSchema = eventSchema("run.finished", RunFinishedPayloadSchema);

export const AgentEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  SubagentStartedEventSchema,
  SubagentFinishedEventSchema,
  StepStartedEventSchema,
  LlmModelSelectedEventSchema,
  LlmTextDeltaEventSchema,
  LlmRetryingEventSchema,
  LlmUsageEventSchema,
  ToolStartedEventSchema,
  ToolRetryingEventSchema,
  ToolFinishedEventSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  StepFinishedEventSchema,
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  RunFinishedEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** event.push 顶层按 type 一次判别，避免嵌套 union 产生含糊分支。 */
export const PushedEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  SubagentStartedEventSchema,
  SubagentFinishedEventSchema,
  StepStartedEventSchema,
  LlmModelSelectedEventSchema,
  LlmTextDeltaEventSchema,
  LlmRetryingEventSchema,
  LlmUsageEventSchema,
  ToolStartedEventSchema,
  ToolRetryingEventSchema,
  ToolFinishedEventSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  StepFinishedEventSchema,
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  RunFinishedEventSchema,
  SessionCompactionStartedEventSchema,
  SessionCompactionFinishedEventSchema,
  SessionCompactionFailedEventSchema,
  SessionTurnAcceptedEventSchema,
  SessionTurnFinishedEventSchema,
]);
export type PushedEvent = z.infer<typeof PushedEventSchema>;

export const EventPushParamsSchema = z.strictObject({
  subscriptionId: SubscriptionIdSchema,
  // event.push 同时承载 run 事件与 session 事件，二者都按 type 严格判别。
  event: PushedEventSchema,
});
export type EventPushParams = z.infer<typeof EventPushParamsSchema>;

/** 判别当前 push 事件是否为 run 级 AgentEvent（携带 runId 与 run sequence）。 */
export function isAgentEvent(event: PushedEvent): event is AgentEvent {
  return "runId" in event;
}

/** 判别当前 push 事件是否为 session 级 SessionEvent（携带 sessionSequence）。 */
export function isSessionEvent(event: PushedEvent): event is SessionEvent {
  return "sessionSequence" in event;
}

export const EventPushNotificationSchema = jsonRpcNotificationSchema(
  EVENT_PUSH_METHOD,
  EventPushParamsSchema,
);
export type EventPushNotification = z.infer<typeof EventPushNotificationSchema>;
