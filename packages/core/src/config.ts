import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CoreEndpoint, Environment } from "@minicode/protocol";
import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";
import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;
export const PermissionModeSchema = z.enum(["bypasspermission", "alwaysask"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export interface CoreConfig extends CoreEndpoint {
  readonly logLevel: LogLevel;
  readonly homeDirectory: string;
  /** 直接组装 CoreApp 的旧调用可省略；生产配置加载后始终显式提供。 */
  readonly permissionMode?: PermissionMode;
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
  const permissionMode = PermissionModeSchema.safeParse(
    (environment.MINICODE_PERMISSION_MODE ?? "bypasspermission").toLowerCase(),
  );
  if (!permissionMode.success) {
    throw new ConfigurationError(
      "invalid MINICODE_PERMISSION_MODE (expected bypasspermission or alwaysask)",
    );
  }
  const homeDirectory = environment.MINICODE_HOME ?? join(homedir(), ".minicode");
  if (!isAbsolute(homeDirectory)) {
    throw new ConfigurationError("invalid MINICODE_HOME (expected an absolute path)");
  }
  return {
    ...endpoint,
    logLevel: logLevel.data,
    homeDirectory,
    permissionMode: permissionMode.data,
  };
}
