import type { AgentEvent } from "@minicode/protocol";
import { LlmError } from "../llm/errors.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { LlmContentPart, LlmResponse, LlmStreamEvent } from "../llm/types.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolInvoker } from "../tools/invoker.ts";
import type { RunCompletion } from "../run/completion.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { ExecutionContext, FailedReason, RunFinishReason } from "./context.ts";

/** 默认系统提示词；Agent 层负责，provider 不内置默认 prompt。 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful coding agent. Use the provided read-only tools to inspect the workspace, then respond with your final answer in plain text. " +
  "For complex, multi-step goals that require several tool calls, first create a task plan with task_create and keep it updated with task_update as you start and finish each piece of work. " +
  "Simple questions and single-step reads do not require a plan.";

/**
 * AgentRunner 用该 reason abort 信号表示“整 run 超时”而非用户取消；
 * loop 据此区分 cancelled 与 run_timeout。
 */
export const RUN_TIMEOUT_REASON = "run-timeout";

/** 协议层 llm.text_delta 的单事件文本上限（字符数），超出时按此分段发布。 */
const MAX_TEXT_DELTA_CHARS = 16 * 1024;
/** run.finished.finalText 的协议层上限（字符数）。 */
const MAX_FINAL_TEXT_CHARS = 256 * 1024;

type StepOutcome = "continue" | "succeeded" | "failed" | "cancelled";

/** 发布事件时只缺少 session/run/timestamp/durable 的描述，由 #publish 补齐。 */
type EventDescriptor = Omit<
  AgentEvent,
  "sequence" | "sessionId" | "runId" | "timestamp" | "durable"
>;

export interface AgentLoopOptions {
  readonly systemPrompt?: string;
  /** 传给 provider 的单次调用超时毫秒数。 */
  readonly timeoutMs?: number;
  /** 传给 provider 的首 delta 前最大尝试次数。 */
  readonly maxAttempts?: number;
  /** 当前 run 的 best-effort Trace 记录器。 */
  readonly trace?: TraceRecorder;
  /** Core 采用的模型上下文窗口，用于向前端发布当前占用比例。 */
  readonly contextWindowTokens?: number;
}

/** EventBus 发布失败（如 event_store_error）时抛出，由 run 映射为结构化失败。 */
class EventPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPublishError";
  }
}

/** 把文本按字符数分段，避免超过协议层单事件上限。 */
function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * 驱动 LLM → tools → tool results → LLM 的主循环。
 * 消费 provider 流、顺序执行工具、把领域事件转换为 IPC 事件发布到 EventBus。
 * 不直接创建 ExecutionContext，由上层（AgentRunner）注入。
 */
export class AgentLoop {
  readonly #provider: LlmProvider;
  readonly #registry: ToolRegistry;
  readonly #invoker: ToolInvoker;
  readonly #bus: EventBus;
  readonly #systemPrompt: string;
  readonly #timeoutMs: number | undefined;
  readonly #maxAttempts: number | undefined;
  readonly #trace: TraceRecorder | undefined;
  readonly #contextWindowTokens: number | undefined;

  constructor(
    provider: LlmProvider,
    registry: ToolRegistry,
    invoker: ToolInvoker,
    bus: EventBus,
    options: AgentLoopOptions = {},
  ) {
    this.#provider = provider;
    this.#registry = registry;
    this.#invoker = invoker;
    this.#bus = bus;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#trace = options.trace;
    this.#contextWindowTokens = options.contextWindowTokens;
  }

  /** 执行直到终止；同一 signal 贯穿 LLM 与工具调用。返回结构化 RunCompletion，不发布 run.finished。 */
  async run(
    context: ExecutionContext,
    signal: AbortSignal,
    runStarted = false,
  ): Promise<RunCompletion> {
    try {
      if (!runStarted) {
        await this.#publish(context, { type: "run.started", payload: {} }, true);
      }

      while (!context.isDone()) {
        if (context.step >= context.maxSteps) {
          context.markFailed("max_steps");
          break;
        }
        context.step += 1;
        await this.#publish(
          context,
          { type: "step.started", payload: { step: context.step } },
          true,
        );

        let outcome: StepOutcome;
        try {
          outcome = await this.#runStep(context, signal);
        } catch (error) {
          if (signal.aborted) {
            if (signal.reason === RUN_TIMEOUT_REASON) {
              context.markFailed("run_timeout");
              outcome = "failed";
            } else {
              context.markCancelled();
              outcome = "cancelled";
            }
          } else {
            context.markFailed(this.#mapError(error));
            outcome = "failed";
          }
        }
        // 每个 step.started 都有对应 step.finished。
        await this.#publish(
          context,
          { type: "step.finished", payload: { step: context.step, outcome } },
          true,
        );
        if (outcome !== "continue") {
          break;
        }
      }

      if (!context.isDone()) {
        context.markFailed("max_steps");
      }
    } catch (error) {
      // run.started / step 事件的发布失败属于存储故障。
      if (!context.isDone()) {
        context.markFailed(this.#mapError(error));
      }
    }
    return this.#completion(context);
  }

  /** 单步：选模型、消费流、累计 usage、按停止原因分派。 */
  async #runStep(context: ExecutionContext, signal: AbortSignal): Promise<StepOutcome> {
    context.model = this.#provider.model;
    await this.#publish(
      context,
      {
        type: "llm.model_selected",
        payload: { model: this.#provider.model, provider: this.#provider.providerName },
      },
      true,
    );

    const response = await this.#consumeStream(context, signal);

    await this.#publish(
      context,
      {
        type: "llm.usage",
        payload: {
          ...response.usage,
          ...(this.#contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: this.#contextWindowTokens }),
        },
      },
      true,
    );
    context.accumulateUsage(response.usage);

    const parts: LlmContentPart[] = [];
    if (response.text.length > 0) {
      parts.push({ type: "text", text: response.text });
    }
    for (const call of response.toolCalls) {
      parts.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
    context.addAssistantMessage(parts);

    switch (response.finishReason) {
      case "end_turn":
        if (response.toolCalls.length > 0) {
          context.markFailed("invalid_llm_response");
          return "failed";
        }
        context.markSucceeded(response.text);
        return "succeeded";
      case "tool_use":
        if (response.toolCalls.length === 0) {
          context.markFailed("invalid_llm_response");
          return "failed";
        }
        await this.#executeTools(context, response.toolCalls, signal);
        return "continue";
      case "max_tokens":
      case "stop_sequence":
        context.markFailed("invalid_llm_response");
        return "failed";
    }
  }

  /** 消费 provider 流，把 text_delta / retrying 事件转换为 IPC 事件，返回 completed 响应。 */
  async #consumeStream(context: ExecutionContext, signal: AbortSignal): Promise<LlmResponse> {
    const startedAt = performance.now();
    this.#trace?.record({
      source: "CORE",
      target: "LLM",
      kind: "llm.request",
      step: context.step,
      data: {
        model: this.#provider.model,
        provider: this.#provider.providerName,
        systemPrompt: this.#systemPrompt,
        messages: context.messages,
        tools: this.#registry.toolSchemas(),
      },
    });
    let response: LlmResponse | undefined;
    try {
      for await (const event of this.#stream(context, signal)) {
        switch (event.type) {
          case "text_delta":
            this.#trace?.record({
              source: "LLM",
              target: "CORE",
              kind: "llm.stream_delta",
              step: context.step,
              data: { bytes: new TextEncoder().encode(event.text).byteLength, delta: event.text },
            });
            for (const chunk of chunkText(event.text, MAX_TEXT_DELTA_CHARS)) {
              await this.#publish(
                context,
                { type: "llm.text_delta", payload: { text: chunk } },
                true,
              );
            }
            break;
          case "retrying":
            await this.#publish(
              context,
              {
                type: "llm.retrying",
                payload: {
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                  delayMs: event.delayMs,
                  reason: event.reason,
                },
              },
              true,
            );
            break;
          case "completed":
            response = event.response;
            break;
        }
      }
      if (response === undefined) {
        throw new LlmError("invalid_response", "stream ended without a completed event");
      }
      this.#trace?.record({
        source: "LLM",
        target: "CORE",
        kind: "llm.response",
        step: context.step,
        durationMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        data: {
          finishReason: response.finishReason,
          usage: response.usage,
          response,
        },
      });
      return response;
    } catch (error) {
      this.#trace?.record({
        source: signal.aborted ? "CORE" : "LLM",
        target: "CORE",
        kind: signal.aborted ? "llm.cancelled" : "llm.error",
        step: context.step,
        durationMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        data: {
          errorCategory: error instanceof LlmError ? error.code : "unknown",
          reason: signal.aborted ? "aborted" : "provider_error",
          safeMessage: signal.aborted ? "LLM request cancelled" : "LLM provider request failed",
        },
      });
      throw error;
    }
  }

  /** 使用当前上下文和统一超时/重试参数调用 provider。 */
  #stream(context: ExecutionContext, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return this.#provider.stream(context.messages, {
      system: this.#systemPrompt,
      toolSchemas: this.#registry.toolSchemas(),
      signal,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      ...(this.#maxAttempts === undefined ? {} : { maxAttempts: this.#maxAttempts }),
    });
  }

  /** 顺序执行全部工具调用，发布 tool.* 事件，结果合并为一条 user message。 */
  async #executeTools(
    context: ExecutionContext,
    toolCalls: readonly { id: string; name: string; input: Record<string, unknown> }[],
    signal: AbortSignal,
  ): Promise<void> {
    const results: { toolUseId: string; content: string; isError: boolean }[] = [];
    for (const call of toolCalls) {
      // 取消后不再开始新的工具，避免产生无意义的工具副作用与事件。
      if (signal.aborted) {
        throw new LlmError("aborted", "agent run cancelled");
      }
      await this.#publish(
        context,
        { type: "tool.started", payload: { toolCallId: call.id, name: call.name, attempt: 1 } },
        true,
      );

      const invocation = await this.#invoker.invoke(call.name, call.input, {
        workspaceRoot: context.workspaceRoot,
        signal,
      });

      for (const retry of invocation.retries) {
        await this.#publish(
          context,
          {
            type: "tool.retrying",
            payload: {
              toolCallId: call.id,
              name: call.name,
              attempt: retry.attempt,
              maxAttempts: retry.maxAttempts,
              delayMs: retry.delayMs,
              errorCode: retry.errorCode,
            },
          },
          true,
        );
      }

      await this.#publish(
        context,
        {
          type: "tool.finished",
          payload: {
            toolCallId: call.id,
            name: call.name,
            isError: invocation.result.isError,
            durationMs: invocation.durationMs,
            outputBytes: invocation.result.outputBytes,
            truncated: invocation.result.truncated,
          },
        },
        true,
      );

      results.push({
        toolUseId: call.id,
        content: invocation.result.content,
        isError: invocation.result.isError,
      });
    }
    context.addToolResults(results);
  }

  /** 依据 context 终态组装结构化 completion。 */
  #completion(context: ExecutionContext): RunCompletion {
    const base = {
      finalText: context.finalText.slice(0, MAX_FINAL_TEXT_CHARS),
      steps: context.step,
      usage: context.usage,
      messages: context.runMessages(),
      model: context.model,
    };
    switch (context.status) {
      case "succeeded":
        return { ...base, status: "succeeded", reason: "completed" };
      case "cancelled":
        return { ...base, status: "cancelled", reason: "cancelled" };
      case "failed":
        return {
          ...base,
          status: "failed",
          reason: context.reason ?? "internal_error",
          error: this.#safeError(context.reason ?? "internal_error"),
        };
      case "running":
        // 防御：极端情况下（如 run.started 未发布成功）仍以失败收尾。
        return {
          ...base,
          status: "failed",
          reason: "internal_error",
          error: this.#safeError("internal_error"),
        };
    }
  }

  /** 把内部失败原因转换成不含 prompt、路径、凭证或 provider 原文的安全错误。 */
  #safeError(reason: FailedReason): { code: string; message: string } {
    return { code: reason, message: `run failed (${reason})` };
  }

  /** 把领域错误映射为 run.finished 的结构化失败原因。 */
  #mapError(error: unknown): FailedReason {
    if (error instanceof EventPublishError) {
      return "event_store_error";
    }
    if (error instanceof LlmError) {
      switch (error.code) {
        case "config_error":
          return "config_error";
        case "timeout":
          return "run_timeout";
        case "invalid_response":
          return "invalid_llm_response";
        case "aborted":
        case "network_error":
        case "rate_limit":
        case "unavailable":
          return "llm_error";
      }
    }
    return "internal_error";
  }

  /** 发布一条 run 级非终态事件；持久化失败会中止当前 loop。 */
  async #publish(
    context: ExecutionContext,
    descriptor: EventDescriptor,
    durable: boolean,
  ): Promise<void> {
    const result = await this.#bus.publish({
      sessionId: context.sessionId,
      runId: context.runId,
      timestamp: now(),
      durable,
      ...descriptor,
    } as Parameters<EventBus["publish"]>[0]);
    if (!result.ok) {
      throw new EventPublishError(result.error.message);
    }
  }
}

export type { RunFinishReason };
