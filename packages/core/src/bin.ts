#!/usr/bin/env bun

import { ConfigurationError, formatEndpoint } from "@minicode/protocol";

import { CoreApp } from "./app.ts";
import { loadCoreConfig } from "./config.ts";

import type { CoreConfig } from "./config.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };
    const handleSignal = (): void => {
      cleanup();
      resolve();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  });
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (args.length > 0) {
    console.error("error: mc-core does not accept arguments");
    return 2;
  }

  let config: CoreConfig;
  try {
    config = loadCoreConfig(Bun.env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error("error: failed to load configuration");
    return 2;
  }

  const app = new CoreApp(config);
  try {
    app.start();
  } catch (error) {
    console.error(`error: failed to listen on ${formatEndpoint(config)} (${errorMessage(error)})`);
    return 1;
  }

  await waitForShutdownSignal();
  await app.stop();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
