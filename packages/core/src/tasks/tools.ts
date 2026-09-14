import type { RunId, SessionId, TaskSnapshot } from "@minicode/protocol";
import { TaskStatusSchema } from "@minicode/protocol";
import { z } from "zod";
import type { EventBus } from "../events/event-bus.ts";
import { ToolError, type Tool } from "../tools/types.ts";
import type { TaskManager } from "./task-store.ts";
import type { CreateTaskInput, TaskStoreFailure, UpdateTaskInput } from "./types.ts";

/** 把 TaskManager 的稳定错误映射为工具层错误；不把底层异常抛给 daemon。 */
function toToolError(failure: TaskStoreFailure): ToolError {
  const code =
    failure.code === "task_not_found"
      ? "not_found"
      : failure.code === "io_error" ||
          failure.code === "task_store_corrupted" ||
          failure.code === "stale_revision"
        ? "io_error"
        : "invalid_params";
  return new ToolError(code, `${failure.code}: ${failure.message}`);
}

/** 创建/更新工具依赖：manager + 发布 task event 所需的身份与 EventBus。 */
export interface TaskToolDependencies {
  readonly manager: TaskManager;
  readonly bus: EventBus;
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** 在任务成功提交后发布 task.created/task.updated；发布失败不影响任务状态。 */
async function publishTaskEvent(
  deps: TaskToolDependencies,
  type: "task.created" | "task.updated",
  revision: number,
  task: TaskSnapshot,
): Promise<void> {
  await deps.bus.publish({
    sessionId: deps.sessionId,
    runId: deps.runId,
    timestamp: new Date().toISOString(),
    durable: true,
    type,
    payload: { revision, task },
  });
}

const TaskCreateParamsSchema = z.strictObject({
  subject: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  blockedBy: z.array(z.number().int().positive()).optional(),
});
type TaskCreateParams = z.infer<typeof TaskCreateParamsSchema>;

const TaskUpdateParamsSchema = z
  .strictObject({
    id: z.number().int().positive(),
    subject: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(4000).optional(),
    status: TaskStatusSchema.optional(),
    blockedBy: z.array(z.number().int().positive()).optional(),
  })
  .refine(
    (value) =>
      value.subject !== undefined ||
      value.description !== undefined ||
      value.status !== undefined ||
      value.blockedBy !== undefined,
    { message: "at least one change field is required" },
  );
type TaskUpdateParams = z.infer<typeof TaskUpdateParamsSchema>;

const TaskListParamsSchema = z.strictObject({
  status: TaskStatusSchema.optional(),
});
type TaskListParams = z.infer<typeof TaskListParamsSchema>;

const TaskGetParamsSchema = z.strictObject({
  id: z.number().int().positive(),
});
type TaskGetParams = z.infer<typeof TaskGetParamsSchema>;

function taskCreateTool(deps: TaskToolDependencies): Tool<TaskCreateParams> {
  return {
    name: "task_create",
    description:
      "Create a task in the run's task plan. Use for complex multi-step goals before starting work.",
    inputSchema: TaskCreateParamsSchema,
    async execute(params) {
      const input: CreateTaskInput = {
        subject: params.subject,
        description: params.description,
        ...(params.blockedBy === undefined ? {} : { blockedBy: params.blockedBy }),
      };
      const result = await deps.manager.create(input);
      if (!result.ok) {
        throw toToolError(result.error);
      }
      await publishTaskEvent(deps, "task.created", result.value.revision, result.value.task);
      return { content: JSON.stringify(result.value) };
    },
  };
}

function taskUpdateTool(deps: TaskToolDependencies): Tool<TaskUpdateParams> {
  return {
    name: "task_update",
    description:
      "Update a task's subject, description, status, or dependencies. Provide at least one change.",
    inputSchema: TaskUpdateParamsSchema,
    async execute(params) {
      const input: UpdateTaskInput = {
        id: params.id,
        ...(params.subject === undefined ? {} : { subject: params.subject }),
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.blockedBy === undefined ? {} : { blockedBy: params.blockedBy }),
      };
      const result = await deps.manager.update(input);
      if (!result.ok) {
        throw toToolError(result.error);
      }
      await publishTaskEvent(deps, "task.updated", result.value.revision, result.value.task);
      return { content: JSON.stringify(result.value) };
    },
  };
}

function taskListTool(deps: TaskToolDependencies): Tool<TaskListParams> {
  return {
    name: "task_list",
    description: "List tasks in the run's plan, optionally filtered by status.",
    inputSchema: TaskListParamsSchema,
    async execute(params) {
      const result = await deps.manager.list(params.status);
      if (!result.ok) {
        throw toToolError(result.error);
      }
      return { content: JSON.stringify(result.value) };
    },
  };
}

function taskGetTool(deps: TaskToolDependencies): Tool<TaskGetParams> {
  return {
    name: "task_get",
    description: "Read a single task from the run's plan.",
    inputSchema: TaskGetParamsSchema,
    async execute(params) {
      const result = await deps.manager.get(params.id);
      if (!result.ok) {
        throw toToolError(result.error);
      }
      return { content: JSON.stringify(result.value) };
    },
  };
}

/** 构造操作同一个 run TaskManager 的四个任务规划工具。 */
export function createTaskTools(dependencies: TaskToolDependencies): Tool[] {
  return [
    taskCreateTool(dependencies) as Tool,
    taskUpdateTool(dependencies) as Tool,
    taskListTool(dependencies) as Tool,
    taskGetTool(dependencies) as Tool,
  ];
}
