import { z } from "zod";

export const DEFAULT_CORE_HOST = "127.0.0.1" as const;
export const DEFAULT_CORE_PORT = 7437;
/** 未显式配置时采用的通用模型上下文窗口，兼容 Stage2 之前的 .env。 */
export const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 200_000;
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

export const CoreEndpointSchema = z.strictObject({
  host: z.enum(LOOPBACK_HOSTS),
  port: z.number().int().min(1).max(65_535),
});
export type CoreEndpoint = z.infer<typeof CoreEndpointSchema>;

export interface Environment {
  readonly MINICODE_CORE_HOST?: string;
  readonly MINICODE_CORE_PORT?: string;
  readonly MINICODE_HOME?: string;
  readonly MINICODE_LOG_LEVEL?: string;
  /** 主 Agent 权限模式；子 Agent 始终使用 bypasspermission。 */
  readonly MINICODE_PERMISSION_MODE?: string;
  readonly MINICODE_COMPACTION_ENABLED?: string;
  readonly MINICODE_COMPACTION_RESERVE_TOKENS?: string;
  readonly MINICODE_COMPACTION_KEEP_RECENT_TOKENS?: string;
  readonly LLM_API_KEY?: string;
  readonly LLM_BASE_URL?: string;
  readonly LLM_MODEL?: string;
  /** 模型 context window 的 token 上限；可选，默认 200000。 */
  readonly LLM_CONTEXT_WINDOW_TOKENS?: string;
  /** 单次输出 token 上限；可选，默认 8192。 */
  readonly LLM_MAX_OUTPUT_TOKENS?: string;
  /** Trace 开关；默认 true。 */
  readonly MINICODE_TRACE_ENABLED?: string;
  /** Trace payload 模式：summary | full；默认 summary。 */
  readonly MINICODE_TRACE_PAYLOAD?: string;
  /** Trace 队列事件数上限；默认 1024，范围 16..65536。 */
  readonly MINICODE_TRACE_QUEUE_EVENTS?: string;
  /** Trace 文件字节上限；默认 33554432，最小 1 MiB。 */
  readonly MINICODE_TRACE_MAX_BYTES?: string;
  /** Trace shutdown 等待毫秒数；默认 2000，范围 100..30000。 */
  readonly MINICODE_TRACE_SHUTDOWN_MS?: string;
  readonly [name: string]: string | undefined;
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export function parseCoreEndpoint(environment: Environment): CoreEndpoint {
  const host = environment.MINICODE_CORE_HOST ?? DEFAULT_CORE_HOST;
  const rawPort = environment.MINICODE_CORE_PORT ?? String(DEFAULT_CORE_PORT);
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;

  const result = CoreEndpointSchema.safeParse({ host, port });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`invalid core endpoint (${details})`);
  }
  return result.data;
}

export function formatEndpoint(endpoint: CoreEndpoint): string {
  const host = endpoint.host === "::1" ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}
