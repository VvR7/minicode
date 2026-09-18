import { dirname, join } from "node:path";
import type { Environment, RunId, SessionId, TaskGraphSnapshot } from "@minicode/protocol";
import { z } from "zod";
import { ExecutionContext } from "../agent/context.ts";
import { AgentLoop, type ContextCompactionHook, DEFAULT_SYSTEM_PROMPT } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/system-prompt.ts";
import { type CompactOptions, Compactor, type ContextEntry } from "../compact/index.ts";
import type { EventBus } from "../events/event-bus.ts";
import { AnthropicAdapter } from "../llm/anthropic-adapter.ts";
import type { LlmConfig } from "../llm/config.ts";
import { loadLlmConfig } from "../llm/config.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { LlmMessage, LlmToolSchema } from "../llm/types.ts";
import { type ContextFiles, loadContextFiles } from "../memory/context-loader.ts";
import { PermissionManager } from "../permissions/manager.ts";
import { loadCompactionConfig } from "../session/compaction-config.ts";
import { loadContextBudgetConfig } from "../session/context-budget.ts";
import { createNoteSaveTool, NoteSaveParamsSchema } from "../session/note-tool.ts";
import { NoteStore } from "../session/notes.ts";
import { nodeSessionStorage } from "../session/storage.ts";
import { nodeTaskStorage, TaskManager, tasksPath } from "../tasks/task-store.ts";
import {
  createTaskTools,
  TaskCreateParamsSchema,
  TaskGetParamsSchema,
  TaskListParamsSchema,
  TaskUpdateParamsSchema,
} from "../tasks/tools.ts";
import type { TaskStorage } from "../tasks/types.ts";
import { builtinTools } from "../tools/builtin/index.ts";
import { ToolInvoker } from "../tools/invoker.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { RunCompletion } from "./completion.ts";
import { createRunSnapshot, type RunSnapshot, type RunSnapshotRequest } from "./snapshot.ts";

/** 系统提示词中注入 notes 的固定区块标题。 */
export const SESSION_NOTES_HEADING = "Session Notes";
const LLM_MODEL_ENV_KEY = "LLM_MODEL";

/** 把本轮开始前读取的 notes 快照追加到基础 system prompt。 */
export function buildRunSystemPrompt(
  notes: string,
  files: ContextFiles = { global: "", project: "" },
): string {
  return composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, files, notes);
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

/** 默认能力目录的快照入口，测试执行器与直接调用 Runner 使用相同组装规则。 */
export function buildRunSnapshot(
  notes: string,
  files: ContextFiles = { global: "", project: "" },
): RunSnapshot {
  return createRunSnapshot(buildRunSystemPrompt(notes, files), runToolSchemas());
}

export interface AgentRunRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly goal: string;
  readonly workspaceRoot: string;
  /** 已成功历史；Runner 会在其后追加本轮 goal。 */
  readonly history?: readonly LlmMessage[];
  readonly contextEntries?: readonly ContextEntry[];
  readonly compact?: ContextCompactionHook;
  /** 已包含本轮开始前 notes 快照的系统提示词。 */
  readonly systemPrompt?: string;
  /** accepted 前准备的提示词与工具目录；提供时优先于旧 systemPrompt 字段。 */
  readonly snapshot?: RunSnapshot;
  /** 编排层注入的 run 级 trace；缺失时跳过 trace 记录。 */
  readonly trace?: TraceRecorder;
}

export interface AgentRunnerOptions {
  readonly permissions?: PermissionManager;
  readonly environment: Environment;
  readonly bus: EventBus;
  /** CoreConfig.homeDirectory，用于构造 run 目录、tasks.json 与 notes.md 路径。 */
  readonly homeDirectory: string;
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
  readonly #providerFactory: (config: LlmConfig) => LlmProvider;
  readonly #taskStorage: TaskStorage;
  readonly #permissions: PermissionManager;

  /** 保存 run 组装所需的环境、存储、事件与可注入依赖。 */
  constructor(options: AgentRunnerOptions) {
    this.#environment = options.environment;
    this.#bus = options.bus;
    this.#homeDirectory = options.homeDirectory;
    this.#providerFactory = options.providerFactory ?? ((config) => new AnthropicAdapter(config));
    this.#taskStorage = options.taskStorage ?? nodeTaskStorage;
    this.#permissions = options.permissions ?? new PermissionManager(options.bus);
  }

  /** 在 preflight 前准备能力快照；后续扩展在此接入 workspace 的 skills/MCP。 */
  async prepareSnapshot(request: RunSnapshotRequest): Promise<RunSnapshot> {
    return buildRunSnapshot(request.notes, request.files);
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

  /** 使用当前模型创建独立摘要调用；压缩的持久化由会话编排层负责。 */
  async compact(options: CompactOptions) {
    const llm = loadLlmConfig(this.#environment);
    const budget = loadContextBudgetConfig(this.#environment);
    if (!llm.ok) throw llm.error;
    if (!budget.ok) throw budget.error;
    const config = loadCompactionConfig(this.#environment, budget.value);
    if (!config.ok) throw config.error;
    return new Compactor(
      this.#providerFactory(llm.value),
      config.value,
      budget.value.maxOutputTokens,
    ).compact(options);
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
      ...(request.contextEntries === undefined ? {} : { prefillEntries: request.contextEntries }),
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
    const contextBudgetConfig = loadContextBudgetConfig(this.#environment);
    if (!contextBudgetConfig.ok) {
      context.markFailed("config_error");
      return { completion: this.#completionFromContext(context) };
    }

    const compactionConfig = loadCompactionConfig(this.#environment, contextBudgetConfig.value);
    if (!compactionConfig.ok) {
      context.markFailed("config_error");
      return { completion: this.#completionFromContext(context) };
    }

    const runDirectory = dirname(tasksPath(this.#homeDirectory, request.sessionId, request.runId));
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

    // 编排层传入的完整快照直接复用；直接调用 Runner 时也加载同样的两处规则。
    const systemPrompt =
      request.snapshot?.systemPrompt ??
      request.systemPrompt ??
      buildRunSystemPrompt(
        (await nodeSessionStorage.readFile(
          join(this.#homeDirectory, "sessions", request.sessionId, "notes.md"),
        )) ?? "",
        await loadContextFiles(this.#homeDirectory, request.workspaceRoot),
      );
    const invoker = new ToolInvoker(registry, { permissions: this.#permissions });
    const loop = new AgentLoop(provider, registry, invoker, this.#bus, {
      systemPrompt,
      toolSchemas: request.snapshot?.toolSchemas ?? registry.toolSchemas(),
      ...(request.trace === undefined ? {} : { trace: request.trace }),
      contextWindowTokens: contextBudgetConfig.value.contextWindowTokens,
      compactionConfig: compactionConfig.value,
      ...(request.compact === undefined ? {} : { compact: request.compact }),
    });
    const completion = await loop.run(context, externalSignal, true);

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
  }

  /** 由 context 组装 RunCompletion。 */
  #completionFromContext(context: ExecutionContext): RunCompletion {
    const base = {
      finalText: context.finalText,
      steps: context.step,
      usage: context.usage,
      messages: context.runMessages(),
      messageIds: context.runMessageIds(),
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
