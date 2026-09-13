#!/usr/bin/env bun

import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";

import { parseGoalArgs, runGoalCommand } from "./commands/goal.ts";

import type { CoreEndpoint } from "@minicode/protocol";

/**
 * `mc --goal <text>` 入口：以 process.cwd 为 workspaceRoot 发起一次 run，
 * assistant delta 写 stdout，进度写 stderr，Ctrl-C 触发取消并返回 130。
 */
export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseGoalArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    console.error("usage: mc --goal <text>");
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

  // Ctrl-C：abort 信号驱动 runGoalCommand 向 core 发送 agent.cancel。
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);

  try {
    return await runGoalCommand({
      goal: parsed.goal,
      workspaceRoot: process.cwd(),
      endpoint,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSignal);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
