import type { Environment, RunId, SessionId } from "@minicode/protocol";
import { ExecutionContext } from "../agent/context.ts";
import { AgentLoop, RUN_TIMEOUT_REASON } from "../agent/loop.ts";
import type { EventBus } from "../events/event-bus.ts";
import { AnthropicAdapter } from "../llm/anthropic-adapter.ts";
import { loadLlmConfig } from "../llm/config.ts";
import type { LlmConfig } from "../llm/config.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { builtinTools } from "../tools/builtin/index.ts";
import { ToolInvoker } from "../tools/invoker.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import type { TraceService } from "../trace/service.ts";

/** 整 run 的默认超时毫秒数（10 分钟）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export interface AgentRunRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly goal: string;
  readonly workspaceRoot: string;
}

export interface AgentRunnerOptions {
  readonly environment: Environment;
  readonly bus: EventBus;
  readonly runTimeoutMs?: number;
  /** 可注入的 provider 工厂，测试用 fake provider 替代真实网络。 */
  readonly providerFactory?: (config: LlmConfig) => LlmProvider;
  /** Core 级 run recorder 注册表；省略时禁用 Trace 集成。 */
  readonly traceService?: TraceService;
}

/**
 * 为一次 run 组装 provider、registry、context、loop 与 AbortSignal，
 * 并保证任何失败都收敛为唯一的 run.finished 事件，绝不向 daemon 抛异常。
 */
export class AgentRunner {
  readonly #environment: Environment;
  readonly #bus: EventBus;
  readonly #runTimeoutMs: number;
  readonly #providerFactory: (config: LlmConfig) => LlmProvider;
  readonly #traceService: TraceService | undefined;

  constructor(options: AgentRunnerOptions) {
    this.#environment = options.environment;
    this.#bus = options.bus;
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.#providerFactory = options.providerFactory ?? ((config) => new AnthropicAdapter(config));
    this.#traceService = options.traceService;
  }

  async run(
    request: AgentRunRequest,
    externalSignal: AbortSignal,
    onStarted: () => Promise<void> = async () => {},
  ): Promise<void> {
    try {
      await this.#run(request, externalSignal, onStarted);
    } catch {
      // 所有失败已在 #run 内收敛为 run.finished；此处兜底防止 daemon 崩溃。
    } finally {
      await this.#traceService?.stopRun(request.sessionId, request.runId);
    }
  }

  async #run(
    request: AgentRunRequest,
    externalSignal: AbortSignal,
    onStarted: () => Promise<void>,
  ): Promise<void> {
    const context = new ExecutionContext({
      sessionId: request.sessionId,
      runId: request.runId,
      workspaceRoot: request.workspaceRoot,
      goal: request.goal,
    });
    await this.#publishStarted(context);
    // 等待 RPC response 入队后才继续执行，既保证 durable start，又保持响应先于事件。
    await onStarted();

    const llmConfig = loadLlmConfig(this.#environment);
    if (!llmConfig.ok) {
      // 缺配置只让当前 run 以 config_error 失败，绝不杀 daemon。
      context.markFailed("config_error");
      await this.#publishFinished(context);
      return;
    }

    // 组合外部取消与整 run 超时；超时用独立 reason 与用户取消区分。
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    const timeoutTimer = setTimeout(() => {
      controller.abort(RUN_TIMEOUT_REASON);
    }, this.#runTimeoutMs);
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const provider = this.#providerFactory(llmConfig.value);
      const registry = new ToolRegistry();
      for (const tool of builtinTools) {
        // builtinTools 为联合类型，注册时收敛为通用 Tool 契约。
        registry.register(tool as Tool);
      }
      const invoker = new ToolInvoker(registry);
      const traceRecorder = this.#traceService?.recorderFor(request.sessionId, request.runId);
      const loop = new AgentLoop(provider, registry, invoker, this.#bus, {
        ...(traceRecorder === undefined ? {} : { traceRecorder }),
      });
      await loop.run(context, controller.signal, true);
    } catch {
      // AgentLoop 自身已发布终态；只有组装依赖失败时 context 仍处于 running，需补齐唯一终态。
      if (!context.isDone()) {
        context.markFailed("internal_error");
        await this.#publishFinished(context);
      }
    } finally {
      clearTimeout(timeoutTimer);
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 在返回 accepted 前持久化 run.started，建立可供重启恢复的 durable 记录。 */
  async #publishStarted(context: ExecutionContext): Promise<void> {
    const started = await this.#bus.publish({
      sessionId: context.sessionId,
      runId: context.runId,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "run.started",
      payload: {},
    } as Parameters<EventBus["publish"]>[0]);
    if (!started.ok) {
      throw new Error(started.error.code);
    }
  }

  /** 不经过 AgentLoop 的失败场景直接发布唯一 run.finished。 */
  async #publishFinished(context: ExecutionContext): Promise<void> {
    const finished = await this.#bus.publish({
      sessionId: context.sessionId,
      runId: context.runId,
      timestamp: new Date().toISOString(),
      durable: true,
      type: "run.finished",
      payload: {
        status: "failed",
        reason: context.reason ?? "internal_error",
        finalText: context.finalText,
        steps: context.step,
        usage: context.usage,
      },
    } as Parameters<EventBus["publish"]>[0]);
    if (!finished.ok) {
      throw new Error(finished.error.code);
    }
  }
}
