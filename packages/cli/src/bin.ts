#!/usr/bin/env bun

import { ConfigurationError, formatEndpoint, parseCoreEndpoint } from "@minicode/protocol";

import { pingCore, PingClientError } from "./ping-client.ts";

import type { CoreEndpoint } from "@minicode/protocol";

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (args.length > 0) {
    console.error("error: mc-ping does not accept arguments");
    return 2;
  }

  let endpoint: CoreEndpoint;
  try {
    endpoint = parseCoreEndpoint(Bun.env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error("error: failed to load configuration");
    return 2;
  }

  try {
    const response = await pingCore(endpoint);
    console.log(
      `pong server=${response.result.serverVersion} uptime=${response.result.uptimeMs}ms latency=${response.latencyMs}ms`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof PingClientError ? error.message : "unexpected ping failure";
    console.error(`error: ${message} (${formatEndpoint(endpoint)})`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
