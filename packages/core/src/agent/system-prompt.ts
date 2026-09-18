import type { SkillDescription } from "@minicode/protocol";
import { loadSkills } from "../skills/loader.ts";
import type { ContextFiles } from "../memory/context-loader.ts";

/** 分层组合运行提示词；文件读取与模型调用不属于此函数的职责。 */
export function composeSystemPrompt(
  base: string,
  files: ContextFiles,
  notes: string,
  skills: readonly SkillDescription[] = [],
): string {
  const sections = [base];
  if (files.global) sections.push(`## Global Context\n${files.global}`);
  if (files.project) {
    sections.push(
      `## Project Context\nProject context takes precedence over global context when their instructions conflict.\n${files.project}`,
    );
  }
  if (notes.trim()) sections.push(`## Session Notes:\n${notes.trim()}`);
  sections.push(
    `## available skills:\n${skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n") : "(none)"}\nRead the corresponding SKILL.md before using a skill. Skills do not change tool permissions.`,
  );
  return sections.join("\n\n");
}

/** 在运行开始时加载技能目录，并一次性组合提示词与正文快照。 */
export async function loadSystemPrompt(
  base: string,
  files: ContextFiles,
  notes: string,
  homeDirectory: string,
  workspaceRoot: string,
) {
  const skillCatalog = await loadSkills(homeDirectory, workspaceRoot);
  return {
    systemPrompt: composeSystemPrompt(base, files, notes, skillCatalog.skills),
    skillCatalog,
  };
}
