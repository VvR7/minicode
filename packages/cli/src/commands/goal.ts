import type {
  AgentEvent,
  CoreEndpoint,
  RunId,
  SessionId,
  SubscriptionId,
} from "@minicode/protocol";
import {
  AGENT_CANCEL_METHOD,
  AGENT_RUN_METHOD,
  AgentCancelResultSchema,
  AgentRunResultSchema,
  EVENT_SUBSCRIBE_METHOD,
  EventPushNotificationSchema,
  EventSubscribeResultSchema,
  formatEndpoint,
} from "@minicode/protocol";
import { NdjsonRpcConnection } from "@minicode/core";

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
 * step/tool/retry 等进度进 stderr，并按 sequence 去重（断线重放安全）。
 */
export class GoalEventReducer {
  #lastSequence = 0;
  #outcome: GoalRunOutcome | undefined;
  #currentStepText = "";

  /** 已处理的最大 sequence，作为断线重连的 afterSequence cursor。 */
  get lastSequence(): number {
    return this.#lastSequence;
  }

  /** run.finished 到达后的终态；尚未结束时为 undefined。 */
  get outcome(): GoalRunOutcome | undefined {
    return this.#outcome;
  }

  /** 消费一条按 sequence 排序的事件，并返回本次应写入终端的增量。 */
  onEvent(event: AgentEvent): GoalEventOutput {
    // 断线重放或乱序到达时跳过已处理过的 sequence。
    if (event.sequence <= this.#lastSequence) {
      return { stderr: [] };
    }
    this.#lastSequence = event.sequence;

    switch (event.type) {
      case "run.started":
        return { stderr: ["run started"] };
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
      case "run.finished": {
        this.#outcome = {
          status: event.payload.status,
          reason: event.payload.reason,
          finalText: event.payload.finalText,
          steps: event.payload.steps,
        };
        // text_delta 不持久化；断线后的终态用 finalText 补齐当前最终 step 尚未输出的后缀。
        const missingFinalText = event.payload.finalText.startsWith(this.#currentStepText)
          ? event.payload.finalText.slice(this.#currentStepText.length)
          : this.#currentStepText.length === 0
            ? event.payload.finalText
            : "";
        return {
          ...(missingFinalText.length === 0 ? {} : { stdout: missingFinalText }),
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

/** 供测试注入的连接工厂。 */
export type GoalConnector = (endpoint: CoreEndpoint) => Promise<NdjsonRpcConnection>;

export interface GoalCommandOptions {
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly endpoint: CoreEndpoint;
  readonly stdout?: GoalOutputSink;
  readonly stderr?: GoalOutputSink;
  /** Ctrl-C 取消信号；abort 时向 core 发 agent.cancel。 */
  readonly signal?: AbortSignal;
  /** 连接工厂，默认走真实 TCP；测试注入 fake。 */
  readonly connect?: GoalConnector;
  /** 断线重连间隔毫秒数。 */
  readonly reconnectDelayMs?: number;
  /** 首次建立 run 前连接失败的最大重试次数，超限返回 usage/config 退出码。 */
  readonly initialConnectAttempts?: number;
  /** Ctrl-C 后等待 run.finished(cancelled) 的兜底超时毫秒数。 */
  readonly cancelTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunIdentity {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

type DrainResult = "finished" | "disconnected";

/**
 * 执行一次 `mc --goal`：连接 core、启动 run、消费事件流，
 * 处理 Ctrl-C 取消与断线重连，最后返回退出码。
 */
export async function runGoalCommand(options: GoalCommandOptions): Promise<number> {
  const writeStdout: GoalOutputSink = options.stdout ?? ((text) => process.stdout.write(text));
  const writeStderr: GoalOutputSink = options.stderr ?? ((text) => process.stderr.write(text));
  const connect: GoalConnector =
    options.connect ?? ((endpoint) => NdjsonRpcConnection.connect(endpoint));
  const signal = options.signal;
  const reconnectDelayMs = options.reconnectDelayMs ?? 100;
  const initialConnectAttempts = options.initialConnectAttempts ?? 3;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000;

  const reducer = new GoalEventReducer();
  let cancelledByUser = false;
  let runIdentity: RunIdentity | undefined;
  let currentConnection: NdjsonRpcConnection | undefined;
  let cancelDeadline: number | undefined;
  const cancelRequested = Promise.withResolvers<void>();

  /** Ctrl-C 触发：向当前连接发 agent.cancel，run 随后会发布 run.finished(cancelled)。 */
  const requestCancel = async (): Promise<void> => {
    if (runIdentity === undefined || currentConnection === undefined) {
      return;
    }
    try {
      await currentConnection.request(
        AGENT_CANCEL_METHOD,
        { sessionId: runIdentity.sessionId, runId: runIdentity.runId },
        AgentCancelResultSchema,
      );
    } catch {
      // 断线时 cancel 失败；重连后由 drain 继续等待 finished，或再次触发 cancel。
    }
  };

  const onAbort = (): void => {
    if (cancelledByUser) {
      return;
    }
    cancelledByUser = true;
    cancelDeadline = Date.now() + cancelTimeoutMs;
    cancelRequested.resolve();
    void requestCancel();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** 在一条连接上消费事件流，直到 run 结束或连接断开。 */
  const drain = (
    connection: NdjsonRpcConnection,
    subscriptionId: SubscriptionId,
  ): Promise<DrainResult> => {
    const finished = Promise.withResolvers<void>();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineReached = cancelRequested.promise.then(
      () =>
        new Promise<void>((resolve) => {
          const remaining = Math.max(0, (cancelDeadline ?? Date.now()) - Date.now());
          deadlineTimer = setTimeout(resolve, remaining);
        }),
    );
    const stopListening = connection.onNotification((notification) => {
      const parsed = EventPushNotificationSchema.safeParse(notification);
      if (!parsed.success) {
        return;
      }
      if (parsed.data.params.subscriptionId !== subscriptionId) {
        return;
      }
      const output = reducer.onEvent(parsed.data.params.event);
      if (output.stdout !== undefined) {
        writeStdout(output.stdout);
      }
      for (const line of output.stderr) {
        writeStderr(`${line}\n`);
      }
      if (reducer.outcome !== undefined) {
        finished.resolve();
      }
    });

    const run = async (): Promise<DrainResult> => {
      try {
        await Promise.race([finished.promise, connection.waitUntilClosed(), deadlineReached]);
        return reducer.outcome !== undefined ? "finished" : "disconnected";
      } finally {
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        stopListening();
      }
    };
    return run();
  };

  try {
    let connectAttempts = 0;
    for (;;) {
      if (cancelDeadline !== undefined && Date.now() > cancelDeadline) {
        return 130;
      }
      if (signal?.aborted === true && reducer.outcome !== undefined) {
        return exitCodeFor(reducer.outcome, cancelledByUser);
      }

      let connection: NdjsonRpcConnection;
      try {
        connection = await connect(options.endpoint);
      } catch {
        // run 尚未建立：连接失败是配置/环境问题，有限重试后返回 2。
        if (runIdentity === undefined) {
          connectAttempts += 1;
          if (connectAttempts >= initialConnectAttempts) {
            writeStderr(`error: cannot connect to core (${formatEndpoint(options.endpoint)})\n`);
            return 2;
          }
        }
        if (signal?.aborted === true) {
          return 130;
        }
        await sleep(reconnectDelayMs);
        continue;
      }
      connectAttempts = 0;
      currentConnection = connection;

      try {
        let subscriptionId: SubscriptionId;
        if (runIdentity === undefined) {
          const response = await connection.request(
            AGENT_RUN_METHOD,
            { goal: options.goal, workspaceRoot: options.workspaceRoot },
            AgentRunResultSchema,
          );
          runIdentity = {
            sessionId: response.result.sessionId,
            runId: response.result.runId,
          };
          subscriptionId = response.result.subscriptionId;
          // Ctrl-C 可能发生在 run 建立之前，run 建立后补发 cancel。
          if (cancelledByUser) {
            void requestCancel();
          }
        } else {
          // 断线重连：用已处理 cursor 续订，重放 durable 事件并去重。
          const response = await connection.request(
            EVENT_SUBSCRIBE_METHOD,
            {
              sessionId: runIdentity.sessionId,
              runId: runIdentity.runId,
              afterSequence: reducer.lastSequence,
            },
            EventSubscribeResultSchema,
          );
          subscriptionId = response.result.subscriptionId;
          // Ctrl-C 可能发生在断线期间；每次重连后幂等补发取消请求。
          if (cancelledByUser) {
            await requestCancel();
          }
        }

        const status = await drain(connection, subscriptionId);
        if (status === "finished") {
          return exitCodeFor(reducer.outcome, cancelledByUser);
        }
        // 连接断开：run 未结束时进入重连循环。
      } catch {
        // request 或 drain 异常：run 已结束则直接退出，否则当作断线重连。
        if (reducer.outcome !== undefined) {
          return exitCodeFor(reducer.outcome, cancelledByUser);
        }
        if (runIdentity === undefined) {
          // agent.run 的响应可能在 accepted 后丢失；禁止重试创建，避免产生重复的孤儿 run。
          writeStderr("error: agent.run failed before acceptance could be confirmed\n");
          return signal?.aborted === true ? 130 : 2;
        }
      } finally {
        connection.close();
        currentConnection = undefined;
      }

      if (cancelDeadline !== undefined && Date.now() > cancelDeadline) {
        return 130;
      }
      await sleep(reconnectDelayMs);
    }
  } catch {
    // 任何未预期的内部错误按 run failure 处理，不向上抛。
    writeStderr("error: goal run failed unexpectedly\n");
    return 1;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
