import type { ContextFiles } from "../memory/context-loader.ts";

/** 分层组合运行提示词；文件读取与模型调用不属于此函数的职责。 */
export function composeSystemPrompt(base: string, files: ContextFiles, notes: string): string {
  const sections = [base];
  if (files.global) sections.push(`## Global Context\n${files.global}`);
  if (files.project) {
    sections.push(
      `## Project Context\nProject context takes precedence over global context when their instructions conflict.\n${files.project}`,
    );
  }
  if (notes.trim()) sections.push(`## Session Notes:\n${notes.trim()}`);
  return sections.join("\n\n");
}
