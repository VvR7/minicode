import { describe, expect, test } from "bun:test";
import { SecretRedactor } from "./redactor.ts";

describe("SecretRedactor", () => {
  test("removes every injected secret from text and JSON", () => {
    const redactor = new SecretRedactor(["sk-real-secret", "https://user:pass@example.test"]);
    const text = redactor.redact("key=sk-real-secret url=https://user:pass@example.test");
    expect(text).not.toContain("sk-real-secret");
    expect(text).not.toContain("user:pass");
    expect(text).toContain("[REDACTED]");

    const value = redactor.redactValue({ nested: ["sk-real-secret"] });
    expect(JSON.stringify(value)).not.toContain("sk-real-secret");
  });

  test("ignores empty and very short values", () => {
    const redactor = new SecretRedactor([undefined, "", "abc"]);
    expect(redactor.redact("abc remains")).toBe("abc remains");
  });
});
