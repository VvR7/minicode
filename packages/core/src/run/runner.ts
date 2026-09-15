import { dirname, join } from "node:path";
import type { Environment, RunId, SessionId, TaskGraphSnapshot } from "@minicode/protocol";
import { ExecutionContext } from "../agent/context.ts";
import { AgentLoop, DEFAULT_SYSTEM_PROMPT, RUN_TIMEOUT_REASON } from "../agent/loop.ts";
import type { EventBus } from "../events/event-bus.ts";
import { AnthropicAdapter } from "../llm/anthropic-adapter.ts";
import { loadLlmConfig } from "../llm/config.ts";
import type { LlmConfig } from "../llm/config.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { LlmMessage } from "../llm/types.ts";
import type { LlmToolSchema } from "../llm/types.ts";
import { z } from "zod";
import { createNoteSaveTool, NoteSaveParamsSchema } from "../session/note-tool.ts";
import { NoteStore } from "../session/notes.ts";
import { nodeSessionStorage } from "../session/storage.ts";
import { TaskManager, nodeTaskStorage, tasksPath } from "../tasks/task-store.ts";
import type { TaskStorage } from "../tasks/types.ts";
import {
  createTaskTools,
  TaskCreateParamsSchema,
  TaskGetParamsSchema,
  TaskListParamsSchema,
  TaskUpdateParamsSchema,
} from "../tasks/tools.ts";
import { builtinTools } from "../tools/builtin/index.ts";
import { ToolInvoker } from "../tools/invoker.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { RunCompletion } from "./completion.ts";

/** 整 run 的默认超时毫秒数（10 分钟）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** 系统提示词中注入 notes 的固定区块标题。 */
export const SESSION_NOTES_HEADING = "Session Notes";
const LLM_MODEL_ENV_KEY = "LLM_MODEL";

/** 把本轮开始前读取的 notes 快照追加到基础 system prompt。 */
export function buildRunSystemPrompt(notes: string): string {
  return notes.length === 0
    ? DEFAULT_SYSTEM_PROMPT
    : `${DEFAULT_SYSTEM_PROMPT}\n\n${SESSION_NOTES_HEADING}:\n${notes}`;
}

/**
 * 返回 run 会暴露给 provider 的稳定工具 schema。
 * 该函数不分配 session/turn/run ID，可安全用于 accepted 前的 context preflight。
 */
export function runToolSchemas(): readonly LlmToolSchema[] {
  const dynamic = [
    {
      name: "task_create",
      description:
        "Create a task in the run's task plan. Use for complex multi-step goals before starting work.",
      inputSchema: TaskCreateParamsSchema,
    },
    {
      name: "task_update",
      description:
        "Update a task's subject, description, status, or dependencies. Provide at least one change.",
      inputSchema: TaskUpdateParamsSchema,
    },
    {
      name: "task_list",
      description: "List tasks in the run's plan, optionally filtered by status.",
      inputSchema: TaskListParamsSchema,
    },
    {
      name: "task_get",
      description: "Read a single task from the run's plan.",
      inputSchema: TaskGetParamsSchema,
    },
    {
      name: "note_save",
      description:
        "Persist a note to the session notes. Notes are injected into future turns' context.",
      inputSchema: NoteSaveParamsSchema,
    },
  ];
  const staticSchemas = builtinTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  }));
  return [
    ...staticSchemas,
    ...dynamic.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    })),
  ];
}

export interface AgentRunRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly goal: string;
  readonly workspaceRoot: string;
  /** 已成功历史；Runner 会在其后追加本轮 goal。 */
  readonly history?: readonly LlmMessage[];
  /** 已包含本轮开始前 notes 快照的系统提示词。 */
  readonly systemPrompt?: string;
  /** 编排层注入的 run 级 trace；缺失时跳过 trace 记录。 */
  readonly trace?: TraceRecorder;
}

export interface AgentRunnerOptions {
  readonly environment: Environment;
  readonly bus: EventBus;
  /** CoreConfig.homeDirectory，用于构造 run 目录、tasks.json 与 notes.md 路径。 */
  readonly homeDirectory: string;
  readonly runTimeoutMs?: number;
  /** 可注入的 provider 工厂，测试用 fake provider 替代真实网络。 */
  readonly providerFactory?: (config: LlmConfig) => LlmProvider;
  /** 可注入的任务存储，测试可替代真实文件系统。 */
  readonly taskStorage?: TaskStorage;
}

/** 一次 run 结束后返回的完整终态，含最终任务图快照。 */
export interface AgentRunOutcome {
  readonly completion: RunCompletion;
}

/**
 * 为一次 run 组装 provider、TaskManager、NoteStore、工具注册表与 AgentLoop。
 * 运行期只发布 run.started/step/llm/tool/task 非终态事件，终态以 RunCompletion 返回，
 * 由编排层在 history 提交后统一发布 run.finished。
 */
export class AgentRunner {
  readonly #environment: Environment;
  readonly #bus: EventBus;
  readonly #homeDirectory: string;
  readonly #runTimeoutMs: number;
  readonly #providerFactory: (config: LlmConfig) => LlmProvider;
  readonly #taskStorage: TaskStorage;

  /** 保存 run 组装所需的环境、存储、事件与可注入依赖。 */
  constructor(options: AgentRunnerOptions) {
    this.#environment = options.environment;
    this.#bus = options.bus;
    this.#homeDirectory = options.homeDirectory;
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.#providerFactory = options.providerFactory ?? ((config) => new AnthropicAdapter(config));
    this.#taskStorage = options.taskStorage ?? nodeTaskStorage;
  }

  /** 执行一次隔离 run；任何组装异常都收敛为包含本轮用户消息的安全终态。 */
  async run(
    request: AgentRunRequest,
    externalSignal: AbortSignal,
    onStarted: () => Promise<void> = async () => {},
  ): Promise<AgentRunOutcome> {
    try {
      return await this.#run(request, externalSignal, onStarted);
    } catch {
      // 极端组装失败：返回 internal_error 终态，绝不向 daemon 抛异常。
      return {
        completion: {
          status: "failed",
          reason: "internal_error",
          finalText: "",
          steps: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          messages: [{ role: "user", content: [{ type: "text", text: request.goal }] }],
          model: this.#environment[LLM_MODEL_ENV_KEY] ?? "",
          error: { code: "internal_error", message: "run failed (internal_error)" },
        },
      };
    }
  }

  /** 组装本轮隔离资源并驱动 AgentLoop，结束后读取最终任务图。 */
  async #run(
    request: AgentRunRequest,
    externalSignal: AbortSignal,
    onStarted: () => Promise<void>,
  ): Promise<AgentRunOutcome> {
    const context = new ExecutionContext({
      sessionId: request.sessionId,
      runId: request.runId,
      workspaceRoot: request.workspaceRoot,
      goal: request.goal,
      ...(request.history === undefined ? {} : { prefillMessages: request.history }),
    });
    await this.#publishStarted(context);
    // 等待 RPC response 入队后才继续执行，既保证 durable start，又保持响应先于事件。
    await onStarted();

    if (externalSignal.aborted) {
      context.markCancelled();
      return { completion: this.#completionFromContext(context) };
    }

    const llmConfig = loadLlmConfig(this.#environment);
    if (!llmConfig.ok) {
      // 缺配置只让当前 run 以 config_error 失败，绝不杀 daemon。
      context.markFailed("config_error");
      return { completion: this.#completionFromContext(context) };
    }

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
      const runDirectory = dirname(
        tasksPath(this.#homeDirectory, request.sessionId, request.runId),
      );
      await nodeSessionStorage.ensureDirectory(runDirectory);

      const taskManager = new TaskManager(
        this.#taskStorage,
        tasksPath(this.#homeDirectory, request.sessionId, request.runId),
      );
      const noteStore = new NoteStore(
        nodeSessionStorage,
        join(this.#homeDirectory, "sessions", request.sessionId, "notes.md"),
        { sessionId: request.sessionId, runId: request.runId },
      );

      const provider = this.#providerFactory(llmConfig.value);
      const registry = new ToolRegistry();
      for (const tool of builtinTools) {
        registry.register(tool as Tool);
      }
      for (const tool of createTaskTools({
        manager: taskManager,
        bus: this.#bus,
        sessionId: request.sessionId,
        runId: request.runId,
      })) {
        registry.register(tool);
      }
      registry.register(createNoteSaveTool(noteStore));

      const invoker = new ToolInvoker(registry);
      const loop = new AgentLoop(provider, registry, invoker, this.#bus, {
        ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
        ...(request.trace === undefined ? {} : { trace: request.trace }),
      });
      const completion = await loop.run(context, controller.signal, true);

      const listed = await taskManager.list();
      const taskGraph: TaskGraphSnapshot | undefined =
        listed.ok && listed.value.tasks.length > 0
          ? { revision: listed.value.revision, tasks: listed.value.tasks }
          : undefined;
      return {
        completion: {
          ...completion,
          ...(taskGraph === undefined ? {} : { taskGraph }),
        },
      };
    } finally {
      clearTimeout(timeoutTimer);
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 由 context 组装 RunCompletion。 */
  #completionFromContext(context: ExecutionContext): RunCompletion {
    const base = {
      finalText: context.finalText,
      steps: context.step,
      usage: context.usage,
      messages: context.runMessages(),
      model: context.model || this.#environment[LLM_MODEL_ENV_KEY] || "",
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
          error: {
            code: context.reason ?? "internal_error",
            message: `run failed (${context.reason ?? "internal_error"})`,
          },
        };
      case "running":
        return {
          ...base,
          status: "failed",
          reason: "internal_error",
          error: { code: "internal_error", message: "run failed (internal_error)" },
        };
    }
  }

  /** 在编排层激活 run 后持久化 run.started，建立可供重启恢复的 durable 记录。 */
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
}
