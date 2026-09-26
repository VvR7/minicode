export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const ACTIVE_PROCESSES = new Set<ReturnType<typeof Bun.spawn>>();

/** 终止当前 runner 发起的宿主子进程，使上层 finally 能立即进入 Docker 清理。 */
export function terminateActiveCommands(): void {
  for (const process of ACTIVE_PROCESSES) process.kill("SIGTERM");
}

/** 执行子进程并分别收集 stdout/stderr，超时后终止宿主命令。 */
export async function runCommand(
  command: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeoutMs: number;
  },
): Promise<CommandResult> {
  const process = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...Bun.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  ACTIVE_PROCESSES.add(process);
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill("SIGTERM");
    forceTimer = setTimeout(() => process.kill("SIGKILL"), 2_000);
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    ACTIVE_PROCESSES.delete(process);
  }
}
