import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";
import { z } from "zod";

import type { CoreEndpoint, Environment } from "@minicode/protocol";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface CoreConfig extends CoreEndpoint {
  readonly logLevel: LogLevel;
}

export function loadCoreConfig(environment: Environment): CoreConfig {
  const endpoint = parseCoreEndpoint(environment);
  const logLevel = LogLevelSchema.safeParse(
    (environment.MINICODE_LOG_LEVEL ?? "info").toLowerCase(),
  );
  if (!logLevel.success) {
    throw new ConfigurationError(
      "invalid MINICODE_LOG_LEVEL (expected debug, info, warn, or error)",
    );
  }
  return { ...endpoint, logLevel: logLevel.data };
}
