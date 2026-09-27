import { z } from "zod";
import type { Environment } from "@minicode/protocol";
import { LlmError } from "../llm/errors.ts";
import { RUNTIME_CONFIG } from "../runtime-config.ts";
import type { ContextBudgetConfig } from "./context-budget.ts";

/** 自动压缩的默认参数；关闭自动压缩仍校验手动压缩所需预算。 */
export const DEFAULT_RESERVE_TOKENS = RUNTIME_CONFIG.context.compactionReserveTokens;
export const DEFAULT_KEEP_RECENT_TOKENS = RUNTIME_CONFIG.context.compactionKeepRecentTokens;
export const CompactionConfigSchema = z.strictObject({
  enabled: z.boolean(),
  reserveTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  keepRecentTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;

/** 将环境数字解析为待校验值，不接受空串、小数或科学计数法。 */
function integer(raw: string | undefined, fallback: number): number {
  return raw === undefined ? fallback : /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
}

/** 解析开关与预算关系；不静默缩小用户指定的参数。 */
export function loadCompactionConfig(
  environment: Environment,
  budget: ContextBudgetConfig,
):
  | { readonly ok: true; readonly value: CompactionConfig }
  | { readonly ok: false; readonly error: LlmError } {
  const rawEnabled = environment.MINICODE_COMPACTION_ENABLED ?? "true";
  const parsed = CompactionConfigSchema.safeParse({
    enabled: rawEnabled === "true" ? true : rawEnabled === "false" ? false : undefined,
    reserveTokens: integer(environment.MINICODE_COMPACTION_RESERVE_TOKENS, DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: integer(
      environment.MINICODE_COMPACTION_KEEP_RECENT_TOKENS,
      DEFAULT_KEEP_RECENT_TOKENS,
    ),
  });
  if (
    !parsed.success ||
    parsed.data.reserveTokens < budget.maxOutputTokens ||
    parsed.data.reserveTokens + parsed.data.keepRecentTokens >= budget.contextWindowTokens
  ) {
    return {
      ok: false,
      error: new LlmError(
        "config_error",
        "invalid compaction configuration: reserve must cover max output and reserve + keepRecent must be smaller than context window",
      ),
    };
  }
  return { ok: true, value: parsed.data };
}
