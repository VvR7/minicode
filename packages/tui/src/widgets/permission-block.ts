import type { ClientPermission } from "@minicode/client";
import type { PermissionDecision } from "@minicode/protocol";

export const PERMISSION_CHOICES: readonly PermissionDecision[] = [
  "allow_once",
  "always_allow",
  "deny_once",
  "always_deny",
];
export const PERMISSION_LABELS: Record<PermissionDecision, string> = {
  allow_once: "Allow once",
  always_allow: "Always allow",
  deny_once: "Deny once",
  always_deny: "Always deny",
};

/** 复合风险只允许单次决策，保留固定编号方便快捷键使用。 */
export function allowedChoices(permission: ClientPermission): readonly PermissionDecision[] {
  return permission.request.payload.cacheable ? PERMISSION_CHOICES : ["allow_once", "deny_once"];
}

/** 展示协议提供的有界摘要；JSON 转义控制字符，不读取原始工具参数。 */
export function formatPermissionBlock(
  permission: ClientPermission,
  selected: PermissionDecision,
  sending = false,
  error?: string,
): string {
  const payload = permission.request.payload;
  const header = `[PERMISSION] ${payload.name} · ${payload.riskCategories.join(", ")}`;
  if (permission.status === "resolved" && permission.resolution !== undefined)
    return `${header} · ${PERMISSION_LABELS[permission.resolution.payload.decision]}`;
  if (permission.status === "closed")
    return `${header} · closed (awaiting authoritative resolution)`;
  const choices = PERMISSION_CHOICES.map((decision, index) => {
    const enabled = allowedChoices(permission).includes(decision);
    return `${enabled && selected === decision ? "▶" : " "} ${index + 1} ${PERMISSION_LABELS[decision]}${enabled ? "" : " (disabled)"}`;
  }).join("\n");
  return `${header}\n${JSON.stringify(payload.summary, null, 2)}\n${payload.cacheable ? (payload.summary.kind === "mcp" ? `Always applies to ${payload.name} in this session only.` : "Always applies to this risk category in this session only.") : "Composite risk: always choices disabled."}\n${choices}\n${sending ? "Sending / awaiting Core resolution…" : "↑/↓ or Tab to select · Enter to send · 1–4 / y,a,n,d shortcuts · Ctrl+C cancel"}${error === undefined ? "" : `\nResponse error: ${JSON.stringify(error)}`}`;
}
