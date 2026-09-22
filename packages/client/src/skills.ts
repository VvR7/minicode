import { SKILL_LIST_METHOD, SkillListResultSchema, type SkillListResult } from "@minicode/protocol";
import type { NdjsonRpcConnection } from "./ndjson-rpc-client.ts";

/** CLI/TUI 通过同一 typed RPC 查询目录，查询不会创建 run。 */
export async function listSkills(
  connection: NdjsonRpcConnection,
  workspaceRoot: string,
): Promise<SkillListResult> {
  return (await connection.request(SKILL_LIST_METHOD, { workspaceRoot }, SkillListResultSchema))
    .result;
}

/** 两个前端共用目录展示，正文不出现在列表中。 */
export function formatSkills(result: SkillListResult): string {
  return result.skills.length
    ? result.skills
        .map((skill) => `${skill.name}: ${skill.description}\n  ${skill.path}`)
        .join("\n")
    : "No available skills.";
}
