import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { classifyBashCommand } from "../bash-policy.ts";
import { ToolError, type Tool, type ToolExecutionContext, type ToolOutput } from "../types.ts";

import { DEFAULT_MAX_LINES, truncateTail } from "../output-budget.ts";
import { RUNTIME_CONFIG } from "../../runtime-config.ts";

const MAX_COMMAND_CHARS = RUNTIME_CONFIG.tool.bashCommandMaxChars;
const MAX_BASH_OUTPUT_BYTES = RUNTIME_CONFIG.tool.outputMaxBytes;
const DEFAULT_BASH_TIMEOUT_SECONDS = RUNTIME_CONFIG.tool.bashTimeoutSeconds;

export const BashParamsSchema = z.strictObject({
  command: z.string().min(1).max(MAX_COMMAND_CHARS),
  timeout: z.number().int().min(1).max(DEFAULT_BASH_TIMEOUT_SECONDS).optional(),
});
export type BashParams = z.infer<typeof BashParamsSchema>;

/** 通过 `/bin/bash -lc` 执行命令，合并输出并在取消/超时时终止整个进程组。 */
export class BashTool implements Tool<BashParams> {
  readonly executeMode = "serial" as const;
  readonly name = "bash";
  readonly description =
    `Run a command with /bin/bash -lc. timeout is 1..${DEFAULT_BASH_TIMEOUT_SECONDS} seconds and defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS}.`;
  readonly inputSchema = BashParamsSchema;

  /** 按调用参数返回 Bash 专用超时，供 ToolInvoker 统一控制。 */
  timeoutMs(params: BashParams): number {
    return (params.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS) * 1000;
  }

  /** 拒绝固定危险命令后启动隔离进程组，并输出最多 2000 行 / 50 KiB 的合并 stdout/stderr。 */
  async execute(params: BashParams, context: ToolExecutionContext): Promise<ToolOutput> {
    if (classifyBashCommand(params.command).decision === "deny") {
      throw new ToolError("permission_denied", "dangerous command denied by policy");
    }
    if (context.signal.aborted) throw new ToolError("tool_cancelled", "tool call cancelled");

    const collector = new OutputCollector(MAX_BASH_OUTPUT_BYTES);
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/bash", ["-lc", `exec 2>&1\n${params.command}`], {
        cwd: context.workspaceRoot,
        detached: true,
        env: filteredEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new ToolError("io_error", "failed to start bash");
    }
    child.stdout.on("data", (chunk: Buffer) => collector.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => collector.append(chunk));

    const onAbort = (): void => terminateProcessGroup(child.pid);
    context.signal.addEventListener("abort", onAbort, { once: true });
    const { code, spawnError } = await new Promise<{ code: number | null; spawnError: boolean }>(
      (resolve) => {
        let failed = false;
        child.once("error", () => {
          failed = true;
        });
        child.once("close", (code) => resolve({ code, spawnError: failed }));
      },
    );
    context.signal.removeEventListener("abort", onAbort);

    if (context.signal.aborted) throw new ToolError("tool_cancelled", "tool call cancelled");
    if (spawnError) throw new ToolError("io_error", "failed to execute bash");
    const prefix = code !== 0 ? `[exit ${code ?? "signal"}]\n` : "";
    const limited = truncateTail(
      collector.text(),
      DEFAULT_MAX_LINES - (prefix ? 1 : 0),
      MAX_BASH_OUTPUT_BYTES - Buffer.byteLength(prefix),
      collector.truncated,
    );
    const output = {
      ...limited,
      content: prefix + (limited.content || (prefix ? "" : "[no output]")),
      outputBytes: collector.totalBytes + Buffer.byteLength(prefix),
    };
    if (code !== 0) throw new ToolError("command_failed", output.content, { output });
    return output;
  }
}

/** 有界收集子进程输出，同时持续排空 pipe 防止子进程阻塞。 */
class OutputCollector {
  readonly #limit: number;
  #tail = Buffer.alloc(0);
  totalBytes = 0;

  /** 创建只保留指定字节尾部的输出收集器。 */
  constructor(limit: number) {
    this.#limit = limit;
  }

  /** 持续消费所有输出，内存只保留最近 limit 字节。 */
  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (chunk.byteLength >= this.#limit) {
      this.#tail = Buffer.from(chunk.subarray(chunk.byteLength - this.#limit));
    } else {
      const joined = Buffer.concat([this.#tail, chunk]);
      this.#tail = Buffer.from(joined.subarray(Math.max(0, joined.byteLength - this.#limit)));
    }
  }

  /** 跳过被截断的 UTF-8 起始片段，再解码任意命令输出。 */
  text(): string {
    let start = 0;
    if (this.truncated) {
      while (start < this.#tail.length && ((this.#tail[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return new TextDecoder().decode(this.#tail.subarray(start));
  }

  /** 指示流式收集阶段是否已经丢弃前部输出。 */
  get truncated(): boolean {
    return this.totalBytes > this.#limit;
  }
}

/** 移除常见 LLM/API 凭证变量，其余环境原样传给本地命令。 */
function filteredEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      value === undefined ||
      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|LLM_)/iu.test(key)
    )
      continue;
    result[key] = value;
  }
  return result;
}

/** 先向进程组发送 SIGTERM，再短暂宽限后补发 SIGKILL。 */
function terminateProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 250);
  timer.unref();
}
