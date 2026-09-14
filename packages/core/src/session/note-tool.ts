import { z } from "zod";
import { ToolError, type Tool } from "../tools/types.ts";
import type { NoteStore } from "./notes.ts";
import { MAX_NOTE_CHARS } from "./types.ts";

export const NoteSaveParamsSchema = z.strictObject({
  content: z.string().min(1).max(MAX_NOTE_CHARS),
});
export type NoteSaveParams = z.infer<typeof NoteSaveParamsSchema>;

/**
 * note_save 工具：把一条 note 追加到 session 的 notes.md。
 * 后续轮次构建 system prompt 时会注入这些 note；失败返回结构化错误，不抛给 daemon。
 */
export function createNoteSaveTool(noteStore: NoteStore): Tool<NoteSaveParams> {
  return {
    name: "note_save",
    description:
      "Persist a note to the session notes. Notes are injected into future turns' context.",
    inputSchema: NoteSaveParamsSchema,
    async execute(params) {
      const result = await noteStore.append(params.content);
      if (!result.ok) {
        throw new ToolError("io_error", `${result.error.code}: ${result.error.message}`);
      }
      return { content: "note saved" };
    },
  };
}
