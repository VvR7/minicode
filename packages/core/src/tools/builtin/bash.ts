import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { classifyBashCommand } from "../bash-policy.ts";
import { ToolError, type Tool, type ToolExecutionContext, type ToolOutput } from "../types.ts";

const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_BASH_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export const BashParamsSchema = z.strictObject({
  command: z.string().min(1).max(MAX_COMMAND_CHARS),
  timeout: z.number().int().min(1).max(DEFAULT_BASH_TIMEOUT_SECONDS).optional(),
});
export type BashParams = z.infer<typeof BashParamsSchema>;

/** 通过 `/bin/bash -lc` 执行命令，合并输出并在取消/超时时终止整个进程组。 */
export class BashTool implements Tool<BashParams> {
  readonly name = "bash";
  readonly description =
    "Run a command with /bin/bash -lc. timeout is 1..120 seconds and defaults to 120.";
  readonly inputSchema = BashParamsSchema;

  /** 按调用参数返回 Bash 专用超时，供 ToolInvoker 统一控制。 */
  timeoutMs(params: BashParams): number {
    return (params.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS) * 1000;
  }

  /** 拒绝固定危险命令后启动隔离进程组，并输出最多 64 KiB 的合并 stdout/stderr。 */
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
    const output = collector.text();
    if (code !== 0) {
      const prefix = `[exit ${code ?? "signal"}]\n`;
      const outputLimit = MAX_BASH_OUTPUT_BYTES - Buffer.byteLength(prefix);
      const content = prefix + collector.text(outputLimit);
      throw new ToolError("command_failed", content, {
        output: {
          content,
          truncated: collector.totalBytes > outputLimit,
          outputBytes: collector.totalBytes + Buffer.byteLength(prefix),
        },
      });
    }
    return {
      content: output.length === 0 ? "[no output]" : output,
      truncated: collector.truncated,
      outputBytes: collector.totalBytes,
    };
  }
}

/** 有界收集子进程输出，同时持续排空 pipe 防止子进程阻塞。 */
class OutputCollector {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #keptBytes = 0;
  totalBytes = 0;

  /** 创建只保留指定字节前缀的输出收集器。 */
  constructor(limit: number) {
    this.#limit = limit;
  }

  /** 记录原始字节数，并只保留结果上限内的前缀。 */
  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    const remaining = this.#limit - this.#keptBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    this.#chunks.push(kept);
    this.#keptBytes += kept.byteLength;
  }

  /** 以替换模式解码输出，避免任意命令字节破坏工具调用。 */
  text(limit = this.#limit): string {
    const decoded = new TextDecoder().decode(Buffer.concat(this.#chunks), {
      stream: this.truncated,
    });
    const encoded = new TextEncoder().encode(decoded);
    return new TextDecoder().decode(encoded.slice(0, limit), {
      stream: encoded.byteLength > limit,
    });
  }

  /** 指示原始输出是否超过 64 KiB。 */
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
