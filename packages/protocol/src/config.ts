import { z } from "zod";

export const DEFAULT_CORE_HOST = "127.0.0.1" as const;
export const DEFAULT_CORE_PORT = 7437;
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
