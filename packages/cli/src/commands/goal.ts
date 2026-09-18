import { listSkills, formatSkills, NdjsonRpcConnection } from "@minicode/client";
import {
  AgentRunClient,
  type AgentRunClientResult,
  type AgentRunConnector,
} from "@minicode/client";
import type { AgentEvent, CoreEndpoint } from "@minicode/protocol";
import { formatEndpoint } from "@minicode/protocol";
import { ApprovalQueue, type PermissionPrompt, promptPermission } from "./permission-prompt.ts";

/** 把文本写到 stdout / stderr 的输出接口，测试可注入捕获 buffer。 */
export type GoalOutputSink = (text: string) => void;

/** `mc --goal` 参数解析结果。 */
export type GoalArgsResult =
  | { readonly ok: true; readonly goal: string }
  | { readonly ok: false; readonly error: string };

/**
 * 解析 `mc --goal <text>` 或 `mc --goal=<text>`。
 * 只接受 --goal 一个选项；其它参数视为 usage 错误。
 */
export function parseGoalArgs(args: readonly string[]): GoalArgsResult {
  let goal: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--goal") {
      const value = args[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--goal requires a value" };
      }
      goal = value;
      i += 1;
    } else if (arg.startsWith("--goal=")) {
      goal = arg.slice("--goal=".length);
    } else {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
  }
  if (goal === undefined || goal.trim().length === 0) {
    return { ok: false, error: "missing required --goal" };
  }
  return { ok: true, goal: goal.trim() };
}

/** 一次 run 的终态，来自 run.finished 事件。 */
export interface GoalRunOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly reason: string;
  readonly finalText: string;
  readonly steps: number;
}

/** reducer 处理一个事件后需要写到两个流的文本。 */
export interface GoalEventOutput {
  readonly stdout?: string;
  readonly stderr: readonly string[];
}

/**
 * 把 run 事件流归约为 CLI 输出：assistant delta 进 stdout，
 * step/tool/retry 等进度进 stderr。sequence 去重与归属校验由共享
 * AgentRunClient 完成，这里只做纯展示映射。
 */
export class GoalEventReducer {
  #outcome: GoalRunOutcome | undefined;
  #currentStepText = "";

  /** run.finished 到达后的终态；尚未结束时为 undefined。 */
  get outcome(): GoalRunOutcome | undefined {
    return this.#outcome;
  }

  /** 消费一条事件，并返回本次应写入终端的增量。 */
  onEvent(event: AgentEvent): GoalEventOutput {
    switch (event.type) {
      case "run.started":
        return { stderr: ["run started"] };
      case "subagent.started":
      case "subagent.finished":
        // 协议先支持新事件，子 Agent 功能接入后再增加生命周期展示。
        return { stderr: [] };
      case "llm.model_selected":
        return { stderr: [`model ${event.payload.model} (${event.payload.provider})`] };
      case "llm.text_delta":
        this.#currentStepText += event.payload.text;
        return { stdout: event.payload.text, stderr: [] };
      case "llm.retrying":
        return {
          stderr: [
            `retrying attempt ${event.payload.attempt}/${event.payload.maxAttempts} (${event.payload.reason})`,
          ],
        };
      case "llm.usage":
        return {
          stderr: [`usage input=${event.payload.inputTokens} output=${event.payload.outputTokens}`],
        };
      case "step.started":
        this.#currentStepText = "";
        return { stderr: [`step ${event.payload.step}`] };
      case "step.finished":
        return { stderr: [`step ${event.payload.step} ${event.payload.outcome}`] };
      case "tool.started":
        return { stderr: [`tool ${event.payload.name}`] };
      case "tool.retrying":
        return {
          stderr: [
            `tool ${event.payload.name} retrying ${event.payload.attempt}/${event.payload.maxAttempts} (${event.payload.errorCode})`,
          ],
        };
      case "tool.finished":
        return {
          stderr: [
            `tool ${event.payload.name} ${event.payload.isError ? "error" : "done"} ${event.payload.outputBytes}B${event.payload.truncated ? " truncated" : ""}`,
          ],
        };
      case "permission.requested":
        return { stderr: [`permission requested for ${event.payload.name}`] };
      case "permission.resolved":
        return {
          stderr: [`permission ${event.payload.allowed ? "allowed" : "denied"}`],
        };
      case "task.created":
      case "task.updated":
        // 任务事件只作为进度展示，不进入 assistant 输出流。
        return {
          stderr: [
            `task #${event.payload.task.id} ${event.payload.task.status} ${event.payload.task.subject}`,
          ],
        };
      case "run.finished": {
        this.#outcome = {
          status: event.payload.status,
          reason: event.payload.reason,
          finalText: event.payload.finalText,
          steps: event.payload.steps,
        };
        // text_delta 不持久化；前缀一致时只补后缀，非前缀表示断线丢失了中间 delta，
        // 此时输出带明确分隔的完整 durable finalText，避免把残缺流式文本误认为最终结果。
        const streamedTextMatches = event.payload.finalText.startsWith(this.#currentStepText);
        const recoveredText = streamedTextMatches
          ? event.payload.finalText.slice(this.#currentStepText.length)
          : `\n--- recovered final response ---\n${event.payload.finalText}`;
        return {
          ...(recoveredText.length === 0 ? {} : { stdout: recoveredText }),
          stderr: [`run ${event.payload.status} (${event.payload.reason})`],
        };
      }
    }
  }
}

/** 把 run 终态映射为进程退出码。 */
export function exitCodeFor(outcome: GoalRunOutcome | undefined, cancelledByUser: boolean): number {
  if (outcome === undefined) {
    return 1;
  }
  switch (outcome.status) {
    case "succeeded":
      return 0;
    case "failed":
      return 1;
    case "cancelled":
      // Ctrl-C 触发取消返回 130；core 关停等非用户取消按 run failure 处理。
      return cancelledByUser ? 130 : 1;
  }
}

/** 把共享客户端的生命周期结果 + 终态映射为进程退出码。 */
export function exitCodeForResult(
  result: AgentRunClientResult,
  outcome: GoalRunOutcome | undefined,
  cancelledByUser: boolean,
): number {
  switch (result.kind) {
    case "finished":
      return exitCodeFor(outcome, cancelledByUser);
    case "cancelled":
      return 130;
    case "connect-failed":
    case "request-error":
    case "acceptance-uncertain":
      return 2;
    case "internal-error":
      return 1;
  }
}

export interface GoalCommandOptions {
  /** 默认要求 stdin/stderr 都是 TTY；无交互终端时自动 deny_once。 */
  readonly interactive?: boolean;
  /** 可注入四选一审批输入；输出始终不进入 assistant stdout。 */
  readonly permissionPrompt?: PermissionPrompt;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  readonly stdout?: GoalOutputSink;
  readonly stderr?: GoalOutputSink;
  /** Ctrl-C 取消信号；abort 时向 core 发 agent.cancel。 */
  readonly signal?: AbortSignal;
  /** 连接工厂，默认走真实 TCP；测试注入 fake。 */
  readonly connect?: AgentRunConnector;
  /** 断线重连间隔毫秒数。 */
  readonly reconnectDelayMs?: number;
  /** 首次建立 run 前连接失败的最大重试次数，超限返回 usage/config 退出码。 */
  readonly initialConnectAttempts?: number;
  /** Ctrl-C 后等待 run.finished(cancelled) 的兜底超时毫秒数。 */
  readonly cancelTimeoutMs?: number;
}

/**
 * 执行一次 `mc --goal`：通过共享 AgentRunClient 连接 core、启动 run、
 * 消费事件流，处理 Ctrl-C 取消与断线重连，最后返回退出码。
 */
export async function runGoalCommand(options: GoalCommandOptions): Promise<number> {
  const writeStdout: GoalOutputSink = options.stdout ?? ((text) => process.stdout.write(text));
  const writeStderr: GoalOutputSink = options.stderr ?? ((text) => process.stderr.write(text));

  if (options.goal.trim() === "/skill") {
    let connection: NdjsonRpcConnection | undefined;
    try {
      connection = await (options.connect ?? NdjsonRpcConnection.connect)(options.endpoint);
      const result = await listSkills(connection, options.workspaceRoot);
      writeStdout(`${formatSkills(result)}\n`);
      for (const diagnostic of result.diagnostics)
        writeStderr(`${diagnostic.path}: ${diagnostic.message}\n`);
      return 0;
    } catch (error) {
      writeStderr(`error: ${error instanceof Error ? error.message : "skill list failed"}\n`);
      return 2;
    } finally {
      connection?.close();
    }
  }

  const reducer = new GoalEventReducer();
  let cancelledByUser = false;
  const client = new AgentRunClient();
  const interactive =
    options.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  const approvals = new ApprovalQueue({
    prompt: interactive ? (options.permissionPrompt ?? promptPermission) : async () => "deny_once",
    respond: (request, decision) =>
      client.respondPermission(request.payload.permissionRequestId, decision),
    write: writeStderr,
  });

  const result = await client.run(
    {
      goal: options.goal,
      workspaceRoot: options.workspaceRoot,
      endpoint: options.endpoint,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.reconnectDelayMs === undefined
        ? {}
        : { reconnectDelayMs: options.reconnectDelayMs }),
      ...(options.initialConnectAttempts === undefined
        ? {}
        : { initialConnectAttempts: options.initialConnectAttempts }),
      ...(options.cancelTimeoutMs === undefined
        ? {}
        : { cancelTimeoutMs: options.cancelTimeoutMs }),
    },
    {
      onEvent: (event) => {
        const output = reducer.onEvent(event);
        if (output.stdout !== undefined) {
          writeStdout(output.stdout);
        }
        for (const line of output.stderr) {
          writeStderr(`${line}\n`);
        }
      },
      onCompaction: (event) => {
        if (event.type === "session.compaction_started") writeStderr("[context] compacting...\n");
        else if (event.type === "session.compaction_finished") {
          const result = event.payload.result;
          writeStderr(
            `[context] ${result.tokensBefore} → ${result.tokensAfter} tokens${result.kind === "fallback" ? "; earlier dialogue hidden without summary" : "; compacted"}\n`,
          );
        } else writeStderr(`[context] ${event.payload.message}\n`);
      },
      onStatus: (status) => {
        approvals.setConnected(status.state === "connected");
        // 用户 Ctrl-C 由共享客户端触发，据此区分用户取消与 core 关停取消。
        if (status.state === "cancelling") {
          cancelledByUser = true;
          approvals.close();
        }
      },
      onPermissions: (permissions) => approvals.update(permissions),
    },
  );
  approvals.close();

  // 只在共享客户端无法自行给出更具体退出码的生命周期错误上补充 stderr 说明。
  if (result.kind === "connect-failed") {
    writeStderr(`error: cannot connect to core (${formatEndpoint(options.endpoint)})\n`);
  } else if (result.kind === "request-error") {
    writeStderr(`error: ${result.message}\n`);
  } else if (result.kind === "acceptance-uncertain") {
    writeStderr("error: agent.run failed before acceptance could be confirmed\n");
  } else if (result.kind === "internal-error") {
    writeStderr("error: goal run failed unexpectedly\n");
  }

  return exitCodeForResult(result, reducer.outcome, cancelledByUser);
}
