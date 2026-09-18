import { readFileSync } from "node:fs";
import type { Environment, ExtensionDiagnostic } from "@minicode/protocol";
import { z } from "zod";

const common = {
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128),
  execute_mode: z.enum(["serial", "parallel"]).optional(),
};
export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...common,
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.strictObject({
    ...common,
    transport: z.literal("http"),
    url: z.url().refine((url) => /^https?:/.test(url)),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export interface McpConfigCatalog {
  readonly servers: readonly McpServerConfig[];
  readonly diagnostics: readonly ExtensionDiagnostic[];
}

/** 读取启动/首次使用时的 TOML 快照，每个无效服务器独立诊断。 */
export function loadMcpConfig(path: string, environment: Environment): McpConfigCatalog {
  const diagnostics: ExtensionDiagnostic[] = [];
  const fail = (code: string, message: string) => diagnostics.push({ path, code, message });
  let document: unknown;
  try {
    document = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      fail("invalid_mcp_config", "无法读取或解析 MCP 配置");
    return { servers: [], diagnostics };
  }
  const root = z
    .object({ mcp: z.strictObject({ servers: z.array(z.unknown()).default([]) }).optional() })
    .safeParse(document);
  if (!root.success) {
    fail("invalid_mcp_config", "MCP 配置需要 [[mcp.servers]] 数组");
    return { servers: [], diagnostics };
  }
  const servers: McpServerConfig[] = [];
  const names = new Set<string>();
  for (const raw of root.data.mcp?.servers ?? []) {
    const parsed = McpServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      fail("invalid_mcp_server", "MCP 服务器配置无效");
      continue;
    }
    if (names.has(parsed.data.name)) {
      fail("duplicate_mcp_server", `MCP 服务器名称重复: ${parsed.data.name}`);
      continue;
    }
    names.add(parsed.data.name);
    try {
      // 只替换字符串值，绝不把认证值或底层异常写入诊断。
      const interpolate = (value: string): string =>
        value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
          const replacement = environment[name];
          if (replacement === undefined) throw new Error("missing environment variable");
          return replacement;
        });
      const config = parsed.data;
      const record = (values: Record<string, string>) =>
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolate(value)]));
      servers.push(
        config.transport === "stdio"
          ? {
              ...config,
              command: interpolate(config.command),
              args: config.args.map(interpolate),
              env: record(config.env),
            }
          : { ...config, url: interpolate(config.url), headers: record(config.headers) },
      );
    } catch {
      fail("missing_mcp_environment", `MCP 服务器 ${parsed.data.name} 引用了缺失的环境变量`);
    }
  }
  return { servers, diagnostics };
}
