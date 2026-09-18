import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExtensionDiagnosticSchema, SkillDescriptionSchema } from "@minicode/protocol";
import { parseDocument } from "yaml";
import { z } from "zod";

/** 正文只保存在 Core 的本轮快照，目录 RPC 不传递正文。 */
export const SkillDefinitionSchema = SkillDescriptionSchema.extend({ body: z.string() });
export const SkillCatalogSchema = z.strictObject({
  skills: z.array(SkillDefinitionSchema),
  diagnostics: z.array(ExtensionDiagnosticSchema),
});
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;

/** 按全局、项目顺序发现技能，以 frontmatter name 为覆盖键。 */
export async function loadSkills(
  homeDirectory: string,
  workspaceRoot: string,
): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { skills: [], diagnostics: [] };
  const byName = new Map<string, z.infer<typeof SkillDefinitionSchema>>();
  for (const root of [join(homeDirectory, "skills"), join(workspaceRoot, ".minicode", "skills")]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        catalog.diagnostics.push({
          path: resolve(root),
          code: "skill_directory_unreadable",
          message: "无法读取技能目录",
        });
      continue;
    }
    for (const entry of entries.sort()) {
      const path = resolve(root, entry, "SKILL.md");
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          catalog.diagnostics.push({ path, code: "skill_unreadable", message: "无法读取技能文件" });
        continue;
      }
      try {
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!match) throw new Error("missing frontmatter");
        const document = parseDocument(match[1] ?? "");
        if (document.errors.length) throw new Error("invalid frontmatter");
        const metadata = document.toJS() as { name?: unknown; description?: unknown } | null;
        const skill = SkillDefinitionSchema.parse({
          name: metadata?.name,
          description: metadata?.description,
          path,
          body: text.slice(match[0].length),
        });
        byName.set(skill.name, skill);
      } catch {
        // 不把 YAML 错误的原文带入诊断，避免泄露正文或无界异常信息。
        catalog.diagnostics.push({
          path,
          code: "invalid_skill",
          message: "技能需要有效的 YAML name 和 description",
        });
      }
    }
  }
  catalog.skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}
