import { z } from "zod";
import type { RunId, SessionId } from "@minicode/protocol";
import { RunIdSchema } from "@minicode/protocol";
import type { Tool } from "../tools/types.ts";
import type { SubagentRegistry } from "./registry.ts";
export const AgentResultParamsSchema = z.strictObject({
  childRunId: RunIdSchema,
  wait: z.boolean().optional(),
});
export type AgentResultParams = z.infer<typeof AgentResultParamsSchema>;
export const AGENT_RESULT_DESCRIPTION =
  "Query an owned background subagent by childRunId. Set wait=true to wait for its terminal result. Only subagents in the current parent run are accessible.";
/** 将父 run 的拥有者身份固定到查询工具，不接受模型覆盖 scope。 */
export function createAgentResultTool(
  registry: SubagentRegistry,
  sessionId: SessionId,
  parentRunId: RunId,
): Tool<AgentResultParams> {
  return {
    name: "agent_result",
    description: AGENT_RESULT_DESCRIPTION,
    inputSchema: AgentResultParamsSchema,
    /** 显式等待不应用普通工具时限，仍接受父取消。 */
    timeoutMs(params) {
      return params.wait ? null : 10000;
    },
    /** 查询终态后只在对应 tool_result 中交付一次结果。 */
    execute(params, context) {
      return registry.result(
        sessionId,
        parentRunId,
        params.childRunId,
        params.wait ?? false,
        context.signal,
      );
    },
  };
}
