import { SubagentRegistry, type SubagentResult } from "./registry.ts";
import { join } from "node:path";
import { z } from "zod";
import type { Environment, RunId, SessionId } from "@minicode/protocol";
import { RunIdSchema, RunFinishedPayloadSchema } from "@minicode/protocol";
import { composeSystemPrompt } from "../agent/system-prompt.ts";
import { EventBus } from "../events/event-bus.ts";
import { EventStore } from "../events/event-store.ts";
import type { RunCompletion } from "../run/completion.ts";
import { createRunSnapshot, type RunSnapshot } from "../run/snapshot.ts";
import { nodeSessionStorage } from "../session/storage.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { ToolError, type ToolOutput } from "../tools/types.ts";
import { loadTraceConfig } from "../trace/config.ts";
import { TraceRecorder } from "../trace/recorder.ts";
import { nodeTraceStorage } from "../trace/storage.ts";
import { allowedSubagentTools, loadSubagentProfile } from "./profiles.ts";
import type { SpawnAgentParams } from "./spawn-tool.ts";

export interface ChildExecution {
  readonly childRunId: RunId;
  readonly directory: string;
  readonly goal: string;
  readonly snapshot: RunSnapshot;
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
  readonly bus: EventBus;
  readonly trace?: TraceRecorder;
}
export interface SubagentExecutorOptions {
  readonly homeDirectory: string;
  readonly sessionId: SessionId;
  readonly parentRunId: RunId;
  readonly workspaceRoot: string;
  readonly snapshot: RunSnapshot;
  readonly registry: ToolRegistry;
  readonly bus: EventBus;
  readonly environment: Environment;
  readonly parentSignal: AbortSignal;
  readonly runChild: (request: ChildExecution, signal: AbortSignal) => Promise<RunCompletion>;
}
const ChildStateSchema = z.object({
  childRunId: RunIdSchema,
  name: z.string().min(1).max(128),
  background: z.boolean().default(false),
  status: z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]),
});

/** 子执行只属于一个父 run，完整状态保存在父目录下，不创建主 session turn。 */
export class SubagentExecutor {
  readonly #options: SubagentExecutorOptions;
  readonly registry: SubagentRegistry;
  #closed = false;

  /** 固定父能力快照、模型执行入口和独立审计位置。 */
  constructor(options: SubagentExecutorOptions) {
    this.#options = options;
    this.registry = new SubagentRegistry(options.sessionId, options.parentRunId);
  }

  /** 登记执行以支持父失败和 shutdown 排空，不设置额外并发上限。 */
  async spawn(params: SpawnAgentParams, signal: AbortSignal): Promise<ToolOutput> {
    if (this.#closed || signal.aborted || this.#options.parentSignal.aborted)
      throw new ToolError("tool_cancelled", "subagent cancelled");
    const profile = await loadSubagentProfile(this.#options.workspaceRoot, params.name);
    const tools = allowedSubagentTools(profile, this.#options.registry);
    if (this.#closed || signal.aborted || this.#options.parentSignal.aborted)
      throw new ToolError("tool_cancelled", "subagent cancelled");
    const childRunId = RunIdSchema.parse(crypto.randomUUID());
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const execution = this.#execute(
      params,
      profile,
      tools.map((tool) => tool.name),
      childRunId,
      AbortSignal.any([signal, controller.signal, this.#options.parentSignal]),
      ready.resolve,
    );
    void execution.catch(ready.reject);
    this.registry.register(
      childRunId,
      profile.name,
      params.background ?? false,
      controller,
      execution,
    );
    if (!params.background)
      return this.registry.result(
        this.#options.sessionId,
        this.#options.parentRunId,
        childRunId,
        true,
        signal,
      );
    try {
      await ready.promise;
    } catch (error) {
      // 初始化失败已通过当前 spawn 的 observation 返回，避免自动重复交付。
      try {
        await this.registry.result(
          this.#options.sessionId,
          this.#options.parentRunId,
          childRunId,
          true,
          signal,
        );
      } catch {}
      throw error;
    }
    return { content: JSON.stringify({ childRunId, status: "running" }) };
  }

  /** 关闭 admission，中断并等待全部子执行及其审计写入。 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.registry.close();
  }

  /** 加载最新类型、严格过滤能力，再执行冷启动的子上下文。 */
  async #execute(
    params: SpawnAgentParams,
    profile: import("./profiles.ts").SubagentProfile,
    toolNames: readonly string[],
    childRunId: RunId,
    signal: AbortSignal,
    onReady: () => void,
  ): Promise<SubagentResult> {
    const o = this.#options;
    if (signal.aborted) throw new ToolError("tool_cancelled", "subagent cancelled");
    const directory = join(
      o.homeDirectory,
      "sessions",
      o.sessionId,
      "runs",
      o.parentRunId,
      "subagents",
      childRunId,
    );
    await nodeSessionStorage.ensureDirectory(directory);
    const statePath = join(directory, "state.json");
    const state = {
      childRunId,
      name: profile.name,
      background: params.background ?? false,
      status: "running" as string,
    };
    await nodeSessionStorage.writeFileAtomic(statePath, JSON.stringify(state));
    const snapshot = createRunSnapshot(
      composeSystemPrompt(
        profile.systemPrompt,
        o.snapshot.contextFiles ?? { global: "", project: "" },
        "",
        o.snapshot.skillCatalog?.skills,
      ),
      o.snapshot.toolSchemas.filter((tool) => toolNames.includes(tool.name)),
      o.snapshot.skillCatalog,
      o.snapshot.contextFiles,
    );
    const config = loadTraceConfig(o.environment);
    const trace = config.ok
      ? new TraceRecorder(
          o.sessionId,
          childRunId,
          config.value,
          nodeTraceStorage,
          o.homeDirectory,
          undefined,
          o.parentRunId,
        )
      : undefined;
    trace?.start();
    const bus = new EventBus(new EventStore(o.homeDirectory, undefined, o.parentRunId), {
      onPersisted: (event) =>
        trace?.record({
          source: "CORE",
          target: "CORE",
          kind: "core.event_persisted",
          data: { type: event.type, sequence: event.sequence },
        }),
    });
    let completion: RunCompletion | undefined;
    let started = false;
    let executionError: unknown;
    try {
      await this.#publish({
        type: "subagent.started",
        payload: { childRunId, name: profile.name, background: params.background ?? false },
      });
      started = true;
      onReady();
      completion = await o.runChild(
        {
          childRunId,
          directory,
          snapshot,
          allowedTools: toolNames,
          maxSteps: profile.maxSteps,
          goal:
            params.context === undefined
              ? params.goal
              : `${params.goal}\n\nExplicit context:\n${params.context}`,
          bus,
          ...(trace === undefined ? {} : { trace }),
        },
        signal,
      );
      state.status = completion.status;
      await nodeSessionStorage.writeFileAtomic(
        join(directory, "history.json"),
        JSON.stringify(completion),
      );
      const finished = await bus.publish({
        sessionId: o.sessionId,
        runId: childRunId,
        timestamp: new Date().toISOString(),
        durable: true,
        type: "run.finished",
        payload: RunFinishedPayloadSchema.parse({
          status: completion.status,
          reason: completion.reason,
          finalText: completion.finalText.slice(0, 256 * 1024),
          steps: completion.steps,
          usage: completion.usage,
          ...(completion.error === undefined ? {} : { error: completion.error }),
        }),
      });
      if (!finished.ok) throw new Error("child audit failed");
    } catch (error) {
      executionError = error;
      state.status = signal.aborted ? "cancelled" : "failed";
    } finally {
      await trace?.stop();
      await nodeSessionStorage.writeFileAtomic(statePath, JSON.stringify(state));
      if (started)
        await this.#publish({
          type: "subagent.finished",
          payload: {
            childRunId,
            name: profile.name,
            background: params.background ?? false,
            status: state.status as "succeeded" | "failed" | "cancelled",
            summary: (completion?.finalText || `subagent ${state.status}`).slice(0, 4096),
            ...(completion?.error === undefined
              ? {}
              : { errorCode: completion.error.code.slice(0, 128) }),
          },
        });
    }
    // started 之前的初始化错误没有可交付子终态，仍由 spawn 工具直接报告。
    if (!started) throw executionError;
    const status = state.status as "succeeded" | "failed" | "cancelled";
    const matchedCompletion = completion?.status === status ? completion : undefined;
    return {
      childRunId,
      name: profile.name,
      status,
      reason: matchedCompletion
        ? matchedCompletion.reason
        : status === "cancelled"
          ? "cancelled"
          : "internal_error",
      ...(matchedCompletion?.error !== undefined
        ? { errorCode: matchedCompletion.error.code }
        : executionError instanceof ToolError
          ? { errorCode: executionError.code }
          : status === "failed"
            ? { errorCode: "internal_error" }
            : {}),
      steps: matchedCompletion?.steps ?? 0,
      content: (completion?.finalText || `subagent ${status}`).slice(0, 256 * 1024 - 2048),
    };
  }

  /** 父流仅记录可重放的身份和终态摘要，不桥接子任务或模型细节。 */
  async #publish(
    event:
      | {
          type: "subagent.started";
          payload: { childRunId: RunId; name: string; background: boolean };
        }
      | {
          type: "subagent.finished";
          payload: {
            childRunId: RunId;
            name: string;
            background: boolean;
            status: "succeeded" | "failed" | "cancelled";
            summary: string;
            errorCode?: string;
          };
        },
  ): Promise<void> {
    const o = this.#options;
    const result = await o.bus.publish({
      ...event,
      sessionId: o.sessionId,
      runId: o.parentRunId,
      timestamp: new Date().toISOString(),
      durable: true,
    });
    if (!result.ok) throw new Error("subagent lifecycle persistence failed");
  }
}

/** 重启只补偿未结束的子执行；不恢复模型调用或创建新的主会话 turn。 */
export async function recoverSubagents(
  homeDirectory: string,
  sessionId: SessionId,
  parentRunId: RunId,
  parentBus?: EventBus,
): Promise<void> {
  const root = join(homeDirectory, "sessions", sessionId, "runs", parentRunId, "subagents");
  for (const directory of await nodeSessionStorage.listDirectories(root)) {
    if (!RunIdSchema.safeParse(directory).success) continue;
    const path = join(root, directory, "state.json");
    const raw = await nodeSessionStorage.readFile(path);
    if (!raw) continue;
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      continue;
    }
    const state = ChildStateSchema.safeParse(document);
    if (!state.success || state.data.childRunId !== directory || state.data.status !== "running")
      continue;
    const store = new EventStore(homeDirectory, undefined, parentRunId);
    const journal = await store.read(sessionId, state.data.childRunId);
    if (!journal.ok) throw new Error("child audit recovery failed");
    if (!journal.value.finished) {
      const finished = await new EventBus(store).publish({
        sessionId,
        runId: state.data.childRunId,
        timestamp: new Date().toISOString(),
        durable: true,
        type: "run.finished",
        payload: {
          status: "failed",
          reason: "core_restarted",
          finalText: "",
          steps: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });
      if (!finished.ok) throw new Error("child terminal recovery failed");
    }
    if (parentBus) {
      const parent = await new EventStore(homeDirectory).read(sessionId, parentRunId);
      if (!parent.ok) throw new Error("parent audit recovery failed");
      if (
        !parent.value.finished &&
        parent.value.events.some(
          (event) =>
            event.type === "subagent.started" && event.payload.childRunId === state.data.childRunId,
        ) &&
        !parent.value.events.some(
          (event) =>
            event.type === "subagent.finished" &&
            event.payload.childRunId === state.data.childRunId,
        )
      ) {
        const finished = await parentBus.publish({
          sessionId,
          runId: parentRunId,
          timestamp: new Date().toISOString(),
          durable: true,
          type: "subagent.finished",
          payload: {
            childRunId: state.data.childRunId,
            name: state.data.name,
            background: state.data.background,
            status: "interrupted",
            summary: "subagent interrupted by Core restart",
          },
        });
        if (!finished.ok) throw new Error("child lifecycle recovery failed");
      }
    }
    await nodeSessionStorage.writeFileAtomic(
      path,
      JSON.stringify({ ...state.data, status: "interrupted" }),
    );
  }
}
