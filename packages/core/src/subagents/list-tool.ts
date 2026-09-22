import { z } from "zod";
import type { Tool } from "../tools/types.ts";
import { listSubagents } from "./profiles.ts";
export const ListSubagentParamsSchema = z.strictObject({});

/** 实时查询类型目录；系统提示词不枚举类型，父 Agent 按需调用该工具。 */
export function createListSubagentTool(): Tool {
  return {
    name: "list_subagent",
    description:
      "Discover available subagent types with names and descriptions. Call before spawn_agent, which requires an exact type name.",
    inputSchema: ListSubagentParamsSchema,
    /** 读取当前工作区 TOML，仅返回类型摘要及有界诊断。 */
    async execute(_params, context) {
      const catalog = await listSubagents(context.workspaceRoot);
      return {
        content: JSON.stringify({
          agents: catalog.profiles.map(({ name, description }) => ({ name, description })),
          diagnostics: catalog.diagnostics,
        }),
      };
    },
  };
}
