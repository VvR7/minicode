#!/usr/bin/env bun

import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";

import { runPingCommand } from "./commands/ping.ts";

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

  return await runPingCommand(endpoint);
}

if (import.meta.main) {
  process.exitCode = await main();
}
