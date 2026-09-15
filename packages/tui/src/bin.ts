#!/usr/bin/env bun

import { ConfigurationError, parseCoreEndpoint } from "@minicode/protocol";
import type { Environment } from "@minicode/protocol";

import { TuiApp } from "./app.ts";
import { parseTuiArgs } from "./options.ts";

/**
 * `mc-tui` 入口：校验五种启动模式与 TTY、加载 core 地址后启动多轮界面。
 * 退出码：0 正常退出 / 2 usage、config、非 TTY 或启动失败。
 */
export async function main(
  args: readonly string[],
  environment: Environment,
  isTty: boolean,
): Promise<number> {
  const parsed = parseTuiArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    console.error("usage: mc-tui [--goal <text> | --continue | --session <id> | --sessions]");
    return 2;
  }
  // 非交互环境无法进入 raw mode / 渲染界面，必须在创建 renderer 前退出。
  if (!isTty) {
    console.error("error: mc-tui requires an interactive terminal (TTY)");
    return 2;
  }

  let endpoint: import("@minicode/protocol").CoreEndpoint;
  try {
    endpoint = parseCoreEndpoint(environment);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error("error: failed to load configuration");
    return 2;
  }

  const app = new TuiApp();
  return await app.run({
    mode: parsed.mode,
    workspaceRoot: process.cwd(),
    endpoint,
  });
}

if (import.meta.main) {
  const isTty = process.stdout.isTTY === true;
  process.exit(await main(Bun.argv.slice(2), Bun.env, isTty));
}
