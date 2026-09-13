import type { Environment } from "@minicode/protocol";
import { z } from "zod";
import { LlmError } from "./errors.ts";

/** LLM 配置：凭证、Anthropic 兼容端点与模型标识。 */
export const LlmConfigSchema = z.strictObject({
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(256),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export type LlmConfigResult =
  | { readonly ok: true; readonly value: LlmConfig }
  | { readonly ok: false; readonly error: LlmError };

const ENV_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;

/**
 * 从环境变量加载 LLM 配置。缺配置或配置非法只返回 config_error，
 * 由调用方决定让对应 run 失败，绝不能在这里抛异常杀死 daemon。
 */
export function loadLlmConfig(environment: Environment): LlmConfigResult {
  const missing = ENV_KEYS.filter((key) => {
    const value = environment[key];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: new LlmError("config_error", `missing LLM configuration: ${missing.join(", ")}`),
    };
  }

  const parsed = LlmConfigSchema.safeParse({
    apiKey: environment[ENV_KEYS[0]],
    baseUrl: environment[ENV_KEYS[1]],
    model: environment[ENV_KEYS[2]],
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: new LlmError("config_error", "invalid LLM configuration"),
    };
  }
  return { ok: true, value: parsed.data };
}
