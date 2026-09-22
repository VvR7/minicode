import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { ExtensionDiagnostic } from "@minicode/protocol";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry.ts";
import { ToolError, type Tool } from "../tools/types.ts";
import planner from "./builtin/planner.toml";
import reviewer from "./builtin/reviewer.toml";
import executor from "./builtin/executor.toml";

const AgentSettingsSchema = z.strictObject({
  description: z.string().trim().min(1).max(1024),
  system_prompt: z.string().trim().min(1),
  allowed_tools: z.array(z.string().min(1)),
  max_steps: z.number().int().min(1).max(100).optional(),
});
const DocumentSchema = z.strictObject({ agent: AgentSettingsSchema });
export interface SubagentProfile {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
}
export interface SubagentCatalog {
  readonly profiles: readonly SubagentProfile[];
  readonly diagnostics: readonly ExtensionDiagnostic[];
}

/** 文件名决定类型名；所有来源执行相同的必填字段校验。 */
function parseProfile(name: string, document: unknown): SubagentProfile {
  const validName = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128)
    .parse(name);
  const { agent } = DocumentSchema.parse(document);
  return {
    name: validName,
    description: agent.description,
    systemPrompt: agent.system_prompt,
    allowedTools: agent.allowed_tools,
    maxSteps: agent.max_steps ?? 20,
  };
}
const BUILTINS = [
  parseProfile("planner", planner),
  parseProfile("reviewer", reviewer),
  parseProfile("executor", executor),
];

/** 每次查询重新扫描项目类型目录，项目文件覆盖同名内置类型。 */
export async function listSubagents(workspaceRoot: string): Promise<SubagentCatalog> {
  const profiles = new Map(BUILTINS.map((profile) => [profile.name, structuredClone(profile)]));
  const diagnostics: ExtensionDiagnostic[] = [];
  const directory = join(workspaceRoot, ".minicode", "agents");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      diagnostics.push({
        path: directory,
        code: "agent_directory_unreadable",
        message: "无法读取子 Agent 类型目录",
      });
    return {
      profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
    };
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".toml")) continue;
    const name = basename(file, ".toml");
    const path = join(directory, file);
    // 已存在的项目类型无效时不能悄悄回退到同名内置类型。
    profiles.delete(name);
    try {
      profiles.set(name, parseProfile(name, Bun.TOML.parse(await readFile(path, "utf8"))));
    } catch {
      diagnostics.push({
        path,
        code: "invalid_agent_profile",
        message:
          "子 Agent 类型需要有效的 description、system_prompt、allowed_tools 和可选 max_steps（1-100）",
      });
    }
  }
  return {
    profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  };
}

/** spawn 入口重新发现和校验指定类型，未知或无效类型明确拒绝。 */
export async function loadSubagentProfile(
  workspaceRoot: string,
  name: string,
): Promise<SubagentProfile> {
  const catalog = await listSubagents(workspaceRoot);
  const profile = catalog.profiles.find((candidate) => candidate.name === name);
  if (!profile) throw new ToolError("invalid_params", `unknown or invalid subagent: ${name}`);
  return profile;
}

/** 完整工具名称白名单；空数组没有工具，禁止子 Agent 再发现或启动子 Agent。 */
export function allowedSubagentTools(
  profile: SubagentProfile,
  registry: ToolRegistry,
): readonly Tool[] {
  const tools: Tool[] = [];
  for (const name of new Set(profile.allowedTools)) {
    if (["spawn_agent", "agent_result", "list_subagent"].includes(name))
      throw new ToolError("invalid_params", `subagent delegation tool is forbidden: ${name}`);
    const tool = registry.get(name);
    if (!tool) throw new ToolError("invalid_params", `unknown allowed tool: ${name}`);
    tools.push(tool);
  }
  return tools;
}
