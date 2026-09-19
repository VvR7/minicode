import { z } from "zod";
import type { Tool, ToolOutput } from "../tools/types.ts";
export const SpawnAgentParamsSchema = z.strictObject({
  name: z.string().min(1).max(128),
  goal: z.string().min(1),
  context: z.string().optional(),
  background: z.boolean().optional(),
});
export type SpawnAgentParams = z.infer<typeof SpawnAgentParamsSchema>;
export const SPAWN_AGENT_DESCRIPTION =
  "Delegate a self-contained task to a named isolated subagent. Call list_subagent to discover available types. Provide all required context explicitly; the child cannot see parent history or notes. By default waits for a structured terminal result; background=true returns childRunId immediately. On failure, inspect reason and errorCode before deciding whether to narrow the task or use a configured larger budget; do not blindly retry the same request.";
/** 同步委派没有工具总时限，由父 run 取消和模型请求时限控制。 */
export function createSpawnAgentTool(
  spawn: (params: SpawnAgentParams, signal: AbortSignal) => Promise<ToolOutput>,
): Tool<SpawnAgentParams> {
  return {
    name: "spawn_agent",
    description: SPAWN_AGENT_DESCRIPTION,
    inputSchema: SpawnAgentParamsSchema,
    /** 同步子任务只响应取消，不应用普通工具超时。 */
    timeoutMs() {
      return null;
    },
    /** 将当前调用的取消信号传给登记的子执行。 */
    execute(params, context) {
      return spawn(params, context.signal);
    },
  };
}
