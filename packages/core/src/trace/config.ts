import type { Environment } from "@minicode/protocol";
import {
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_MAX_BYTES_MIN,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_QUEUE_EVENTS_MAX,
  TRACE_QUEUE_EVENTS_MIN,
  TRACE_SHUTDOWN_MS_DEFAULT,
  TRACE_SHUTDOWN_MS_MAX,
  TRACE_SHUTDOWN_MS_MIN,
  TracePayloadModeSchema,
  type TraceConfig,
} from "./types.ts";

export type TraceConfigResult =
  | { readonly ok: true; readonly value: TraceConfig }
  | { readonly ok: false; readonly message: string };

/** 解析布尔开关：仅接受 "true"/"false"，未设置默认 true。 */
function parseEnabled(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return true;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return undefined;
}

/** 解析 [min, max] 内的整数；非法返回 undefined。 */
function parseIntegerInRange(
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/**
 * 从环境变量加载 Trace 配置。
 * enabled=false 直接返回禁用配置，不再校验其余字段；
 * 其余字段非法时返回结构化错误，由调用方决定降级为禁用或失败。
 */
export function loadTraceConfig(environment: Environment): TraceConfigResult {
  const enabled = parseEnabled(environment.MINICODE_TRACE_ENABLED);
  if (enabled === undefined) {
    return { ok: false, message: "invalid MINICODE_TRACE_ENABLED (expected true or false)" };
  }
  if (!enabled) {
    return {
      ok: true,
      value: {
        enabled: false,
        payload: "summary",
        queueEvents: TRACE_QUEUE_EVENTS_DEFAULT,
        maxBytes: TRACE_MAX_BYTES_DEFAULT,
        shutdownMs: TRACE_SHUTDOWN_MS_DEFAULT,
      },
    };
  }

  const rawPayload = environment.MINICODE_TRACE_PAYLOAD ?? "summary";
  const payload = TracePayloadModeSchema.safeParse(rawPayload);
  if (!payload.success) {
    return { ok: false, message: "invalid MINICODE_TRACE_PAYLOAD (expected summary or full)" };
  }

  const rawQueue = environment.MINICODE_TRACE_QUEUE_EVENTS;
  let queueEvents = TRACE_QUEUE_EVENTS_DEFAULT;
  if (rawQueue !== undefined) {
    const parsed = parseIntegerInRange(rawQueue, TRACE_QUEUE_EVENTS_MIN, TRACE_QUEUE_EVENTS_MAX);
    if (parsed === undefined) {
      return {
        ok: false,
        message: `invalid MINICODE_TRACE_QUEUE_EVENTS (expected ${TRACE_QUEUE_EVENTS_MIN}..${TRACE_QUEUE_EVENTS_MAX})`,
      };
    }
    queueEvents = parsed;
  }

  const rawMaxBytes = environment.MINICODE_TRACE_MAX_BYTES;
  let maxBytes = TRACE_MAX_BYTES_DEFAULT;
  if (rawMaxBytes !== undefined) {
    if (!/^\d+$/u.test(rawMaxBytes)) {
      return {
        ok: false,
        message: "invalid MINICODE_TRACE_MAX_BYTES (expected a positive integer)",
      };
    }
    const parsed = Number.parseInt(rawMaxBytes, 10);
    if (!Number.isSafeInteger(parsed) || parsed < TRACE_MAX_BYTES_MIN) {
      return {
        ok: false,
        message: `invalid MINICODE_TRACE_MAX_BYTES (minimum ${TRACE_MAX_BYTES_MIN})`,
      };
    }
    maxBytes = parsed;
  }

  const rawShutdown = environment.MINICODE_TRACE_SHUTDOWN_MS;
  let shutdownMs = TRACE_SHUTDOWN_MS_DEFAULT;
  if (rawShutdown !== undefined) {
    const parsed = parseIntegerInRange(rawShutdown, TRACE_SHUTDOWN_MS_MIN, TRACE_SHUTDOWN_MS_MAX);
    if (parsed === undefined) {
      return {
        ok: false,
        message: `invalid MINICODE_TRACE_SHUTDOWN_MS (expected ${TRACE_SHUTDOWN_MS_MIN}..${TRACE_SHUTDOWN_MS_MAX})`,
      };
    }
    shutdownMs = parsed;
  }

  return {
    ok: true,
    value: {
      enabled: true,
      payload: payload.data,
      queueEvents,
      maxBytes,
      shutdownMs,
    },
  };
}
