import type { LlmContentPart } from "../llm/types.ts";
import type { SkillCatalog } from "./loader.ts";

/** Core 统一识别显式技能调用，普通消息不做任何展开。 */
export function expandSkillCommand(
  content: string,
  catalog?: SkillCatalog,
):
  | { readonly ok: true; readonly userContent?: readonly LlmContentPart[] }
  | { readonly ok: false; readonly message: string } {
  const match = /^\/skill(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!match) return { ok: true };
  const invocation = match[1]?.trim();
  if (!invocation) return { ok: false, message: "请使用 skill.list 查询可用技能" };
  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(invocation);
  const name = parts?.[1];
  const skill = catalog?.skills.find((item) => item.name === name);
  if (!skill) return { ok: false, message: `unknown skill: ${name ?? ""}` };
  return {
    ok: true,
    userContent: [
      // 首块保留原始命令，展示与 clientMessageId 幂等检查使用它。
      { type: "text", text: content },
      {
        type: "text",
        text: `Skill: ${skill.name}\n${skill.body}\n\nArguments:\n${parts?.[2] ?? ""}`,
      },
    ],
  };
}
