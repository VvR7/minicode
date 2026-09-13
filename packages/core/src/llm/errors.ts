/**
 * provider 层的类型化错误。与 IPC 的稳定错误码不同，这是 core 内部领域错误，
 * AgentLoop / AgentRunner 会把它们映射为 run.finished 的结构化失败原因。
 */

export type LlmErrorCode =
  | "config_error"
  | "network_error"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "invalid_response";

/** 首 delta 前允许有限重试的瞬时失败类别。 */
const RETRYABLE_CODES: ReadonlySet<LlmErrorCode> = new Set<LlmErrorCode>([
  "network_error",
  "rate_limit",
  "unavailable",
]);

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}
