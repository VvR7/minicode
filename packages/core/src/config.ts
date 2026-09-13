import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CoreEndpoint, Environment } from "@minicode/protocol";
import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";
import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface CoreConfig extends CoreEndpoint {
  readonly logLevel: LogLevel;
  readonly homeDirectory: string;
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
  const homeDirectory = environment.MINICODE_HOME ?? join(homedir(), ".minicode");
  if (!isAbsolute(homeDirectory)) {
    throw new ConfigurationError("invalid MINICODE_HOME (expected an absolute path)");
  }
  return { ...endpoint, logLevel: logLevel.data, homeDirectory };
}
