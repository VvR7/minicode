import { TRACE_FIELD_MAX_BYTES } from "./types.ts";

/** 脱敏后的占位符。 */
export const REDACTED = "[REDACTED]";

/**
 * 需要整体屏蔽的 credential 字段（归一化后精确匹配）。
 * authorization、proxyAuthorization、cookie、setCookie 不带 token/secret 后缀，
 * 只能精确匹配；其余字段由后缀规则覆盖。
 */
const CREDENTIAL_EXACT_KEYS = new Set<string>([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
]);

/**
 * credential 字段后缀（归一化后匹配）。
 * 覆盖 apiKey、accessToken、refreshToken、clientSecret、password
 * 以及环境变量 _API_KEY、_TOKEN、_SECRET、_PASSWORD。
 * 注意后缀是单数 "token"，因此 inputTokens/outputTokens 不会误删。
 */
const CREDENTIAL_SUFFIXES = ["apikey", "token", "secret", "password"] as const;

/** summary 模式下剥离的内容型字段（归一化后精确匹配）。 */
const SUMMARY_CONTENT_KEYS = new Set<string>([
  "prompt",
  "systemprompt",
  "text",
  "content",
  "usertext",
  "assistanttext",
  "input",
  "output",
  "arguments",
  "args",
  "result",
  "response",
  "body",
  "payload",
  "delta",
  "finaltext",
  "headers",
  "description",
  "instructions",
]);

/** Bearer / Basic / Digest 等认证字符串；出现在任意字符串值中都替换。 */
const AUTH_STRING_PATTERN = /\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{8,}/giu;

const encoder = new TextEncoder();

/** 归一化字段名：小写并去掉 - _ 空格 . 等分隔符。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]+/gu, "");
}

/** 判断字段是否为 credential 字段。 */
export function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    CREDENTIAL_EXACT_KEYS.has(normalized) ||
    CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** 判断字段是否为 summary 模式应剥离的内容型字段。 */
function isContentKey(key: string): boolean {
  return SUMMARY_CONTENT_KEYS.has(normalizeKey(key));
}

/**
 * 递归脱敏：credential 字段值替换为占位符，普通字符串值中的认证串也替换。
 * 处理循环引用为 "[Circular]"，避免无限递归。
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    return value.replace(AUTH_STRING_PATTERN, REDACTED);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isCredentialKey(key) ? REDACTED : redact(item, seen);
  }
  return result;
}

/**
 * summary 模式转换：剥离 prompt、正文、工具输入/输出等业务内容，
 * 保留结构、计数、状态、名称、模型、用量和耗时等安全字段。
 */
export function summarize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(summarize);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isContentKey(key) ? "[summarized]" : summarize(item);
  }
  return result;
}

/** 按 UTF-8 字节截断字符串，且不在多字节字符中间切断。 */
function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).byteLength;
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

/**
 * 递归截断超长字符串字段，保证单字段不超过 64 KiB。
 * 只截断业务字符串，不改变结构。
 */
export function truncateFields(value: unknown): unknown {
  if (typeof value === "string") {
    const bytes = encoder.encode(value).byteLength;
    if (bytes > TRACE_FIELD_MAX_BYTES) {
      return `${truncateUtf8(value, TRACE_FIELD_MAX_BYTES)}…[truncated]`;
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(truncateFields);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = truncateFields(item);
  }
  return result;
}
