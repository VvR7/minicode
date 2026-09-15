import { describe, expect, test } from "bun:test";
import {
  REDACTED,
  isCredentialKey,
  redact,
  summarize,
  truncateFields,
} from "../../src/trace/redact.ts";
import { TRACE_FIELD_MAX_BYTES } from "../../src/trace/types.ts";

interface NestedAuth {
  readonly Authorization: string;
}
interface ListItem {
  readonly setCookie: string;
  readonly note: string;
}
interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
interface RedactInput {
  readonly apiKey: string;
  readonly nested: NestedAuth;
  readonly list: ListItem[];
  readonly usage: Usage;
}

interface MessageBlock {
  readonly type: string;
  readonly text: string;
}
interface Message {
  readonly role: string;
  readonly content: MessageBlock[];
}
interface Tool {
  readonly name: string;
  readonly description: string;
}
interface SummaryInput {
  readonly model: string;
  readonly status: string;
  readonly systemPrompt: string;
  readonly messages: Message[];
  readonly tools: Tool[];
  readonly usage: Usage;
}

interface TruncateInput {
  readonly small: string;
  readonly big: string;
  readonly nested: { readonly alsoBig: string };
}

interface SummarizedMessage {
  readonly role: string;
  readonly content: string;
}
interface SummarizedTool {
  readonly name: string;
  readonly description: string;
}
interface SummarizedOutput {
  readonly model: string;
  readonly status: string;
  readonly systemPrompt: string;
  readonly messages: SummarizedMessage[];
  readonly tools: SummarizedTool[];
  readonly usage: Usage;
}

describe("isCredentialKey", () => {
  test("matches exact credential names case and separator insensitively", () => {
    for (const key of [
      "authorization",
      "Authorization",
      "proxyAuthorization",
      "proxy_authorization",
      "cookie",
      "setCookie",
      "set-cookie",
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  test("matches credential suffixes and environment variable forms", () => {
    for (const key of [
      "apiKey",
      "API-KEY",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "password",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  test("does not treat usage token fields as credentials", () => {
    for (const key of ["inputTokens", "outputTokens", "promptTokens", "model", "tool", "name"]) {
      expect(isCredentialKey(key)).toBe(false);
    }
  });
});

describe("redact", () => {
  test("masks credential values recursively and replaces auth strings", () => {
    const input: RedactInput = {
      apiKey: "sk-secret-123",
      nested: { Authorization: "Bearer abcdef1234567890" },
      list: [{ setCookie: "session=abc", note: "Authorization: Basic dXNlcjpwYXNz" }],
      usage: { inputTokens: 42, outputTokens: 7 },
    };
    const output = redact(input) as RedactInput;
    expect(output.apiKey).toBe(REDACTED);
    expect(output.nested.Authorization).toBe(REDACTED);
    expect(output.list[0]?.setCookie).toBe(REDACTED);
    expect(output.list[0]?.note).toBe("Authorization: [REDACTED]");
    expect(output.usage.inputTokens).toBe(42);
    expect(output.usage.outputTokens).toBe(7);
  });

  test("handles circular references without recursing forever", () => {
    const circular: { a: number; self?: unknown } = { a: 1 };
    circular.self = circular;
    const output = redact(circular) as { a: number; self: unknown };
    expect(output.self).toBe("[Circular]");
  });

  test("masks short authorization values", () => {
    expect(redact("Bearer abc")).toBe(REDACTED);
    expect(redact("prefix Basic x suffix")).toBe(`prefix ${REDACTED} suffix`);
  });
});

describe("summarize", () => {
  test("strips content fields but keeps structure, status, names and usage", () => {
    const input: SummaryInput = {
      model: "test-model",
      status: "succeeded",
      systemPrompt: "top secret instructions",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "read_file", description: "reads a file" }],
      usage: { inputTokens: 10, outputTokens: 3 },
    };
    const output = summarize(input) as unknown as SummarizedOutput;
    expect(output.model).toBe("test-model");
    expect(output.status).toBe("succeeded");
    expect(output.systemPrompt).toBe("[summarized]");
    expect(output.messages[0]?.role).toBe("user");
    expect(output.messages[0]?.content).toBe("[summarized]");
    expect(output.tools[0]?.name).toBe("read_file");
    expect(output.tools[0]?.description).toBe("[summarized]");
    expect(output.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  test("summarizes unknown content-like fields by default", () => {
    const output = summarize({ userMessage: "secret", toolInput: "secret", random: "secret" });
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  test("does not trust malformed safe-container values", () => {
    const output = summarize({ messages: ["SECRET"], tools: "SECRET", usage: "SECRET" });
    expect(JSON.stringify(output)).not.toContain("SECRET");
  });

  test("only keeps scalar values for safe summary fields", () => {
    const output = summarize({ model: { hidden: "SECRET" }, status: ["SECRET"] });
    expect(JSON.stringify(output)).not.toContain("SECRET");
  });
});

describe("truncateFields", () => {
  test("truncates oversized strings and leaves small values untouched", () => {
    const big = "x".repeat(TRACE_FIELD_MAX_BYTES + 100);
    const output = truncateFields({ small: "ok", big, nested: { alsoBig: big } }) as TruncateInput;
    expect(output.small).toBe("ok");
    expect(new TextEncoder().encode(output.big).byteLength).toBeLessThanOrEqual(
      TRACE_FIELD_MAX_BYTES,
    );
    expect(output.big.endsWith("…[truncated]")).toBe(true);
    expect(output.nested.alsoBig.endsWith("…[truncated]")).toBe(true);
  });
});
