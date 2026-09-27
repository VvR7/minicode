const REDACTED = "[REDACTED]";

/** 使用实际注入的敏感值对任意字符串进行二次脱敏。 */
export class SecretRedactor {
  readonly #secrets: readonly string[];

  /** 保存去重后的非空 secret，并优先替换更长的值。 */
  constructor(secrets: readonly (string | undefined)[]) {
    this.#secrets = [...new Set(secrets.filter((value): value is string => Boolean(value)))]
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
  }

  /** 脱敏文本中的所有已知 secret 原值。 */
  redact(text: string): string {
    return this.#secrets.reduce((result, secret) => result.split(secret).join(REDACTED), text);
  }

  /** 深度脱敏可 JSON 序列化的值。 */
  redactValue<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }

  /** 判断文本是否包含实际注入的 secret。 */
  containsSecret(text: string): boolean {
    return this.#secrets.some((secret) => text.includes(secret));
  }
}
