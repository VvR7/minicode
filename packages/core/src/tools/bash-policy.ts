import type { PermissionRiskCategory } from "@minicode/protocol";

export type BashPolicyDecision = "allow" | "deny" | "ask";
export interface BashPolicyResult {
  readonly decision: BashPolicyDecision;
  readonly riskCategories: readonly PermissionRiskCategory[];
  readonly cacheable: boolean;
}

const DANGEROUS_PATTERNS = [
  /(?:^|\s)rm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\s+(?:\/|~)(?:\s|$)/u,
  /(?:^|\s)git\s+reset\s+--hard(?:\s|$)/u,
  /(?:^|\s)git\s+clean\s+-[A-Za-z]*f/u,
  /(?:^|\s)(?:shutdown|reboot|poweroff|halt|mkfs(?:\.[\w-]+)?)\b/u,
  /(?:^|\s)dd\b[^\n]*\bof=\/dev\//u,
  /:\(\)\s*\{\s*:\|:&\s*;\s*\}/u,
] as const;

const SIMPLE_SHELL_META = /[;|&><`\n\r]|\$\(/u;
const SAFE_COMMANDS = /^(?:pwd|ls|find|rg|grep|cat|head|tail|wc)(?:\s|$)/u;
const SAFE_SED = /^sed\s+-n(?:\s|$)/u;
const SAFE_GIT = /^git\s+(?:status|diff|log|show|branch|rev-parse)(?:\s|$)/u;

/** 对 Bash 命令做固定规则分类；它是权限层和执行层共用的唯一策略入口。 */
export function classifyBashCommand(command: string): BashPolicyResult {
  const trimmed = command.trim();
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { decision: "deny", riskCategories: inferRisks(trimmed), cacheable: false };
  }
  if (!SIMPLE_SHELL_META.test(trimmed) && isSafeCommand(trimmed)) {
    return { decision: "allow", riskCategories: [], cacheable: false };
  }
  const riskCategories = inferRisks(trimmed);
  return {
    decision: "ask",
    riskCategories,
    cacheable: riskCategories.length === 1 && !SIMPLE_SHELL_META.test(trimmed),
  };
}

/** 判断无复合 shell 操作符的命令是否落在固定只读白名单。 */
function isSafeCommand(command: string): boolean {
  if (/^find\b/u.test(command) && /\s-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/u.test(command))
    return false;
  if (
    /^git\s+branch\b/u.test(command) &&
    /\s(?:-[dDmMcC]|--(?:delete|move|copy))(?:\s|$)/u.test(command)
  )
    return false;
  return SAFE_COMMANDS.test(command) || SAFE_SED.test(command) || SAFE_GIT.test(command);
}

/** 用轻量启发式生成审批缓存所需的一个或多个风险类别。 */
function inferRisks(command: string): PermissionRiskCategory[] {
  const risks: PermissionRiskCategory[] = [];
  if (
    /\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|install|truncate)\b|\bsed\s+-i\b|\bgit\s+(?:add|commit|checkout|switch|merge|rebase|reset|clean)\b/u.test(
      command,
    )
  ) {
    risks.push("bash:workspace-mutation");
  }
  if (/\b(?:curl|wget|ssh|scp|rsync|nc|telnet|ftp)\b|https?:\/\//u.test(command)) {
    risks.push("bash:network");
  }
  if (
    /\b(?:bash|sh|zsh|fish|node|bun|npm|npx|pnpm|yarn|python\d*|ruby|perl|java|go|cargo|make)\b/u.test(
      command,
    )
  ) {
    risks.push("bash:process-execution");
  }
  if (risks.length === 0) risks.push("bash:other");
  return risks;
}
