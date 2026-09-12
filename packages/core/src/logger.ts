import type { LogLevel } from "./config.ts";

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel): Logger {
  const write = (messageLevel: LogLevel, message: string): void => {
    if (levelPriority[messageLevel] < levelPriority[level]) {
      return;
    }
    console.error(`${new Date().toISOString()} ${messageLevel.toUpperCase()} ${message}`);
  };

  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
