import { describe, expect, test } from "bun:test";
import { truncateHead, truncateTail, DEFAULT_MAX_BYTES } from "../../src/tools/output-budget.ts";

describe("tool output budgets", () => {
  test("retains output unchanged at the limits including final newline", () => {
    for (const text of ["", "short", "a\n".repeat(2000), "x".repeat(DEFAULT_MAX_BYTES)]) {
      for (const truncate of [truncateHead, truncateTail]) {
        expect(truncate(text)).toEqual({
          content: text,
          truncated: false,
          outputBytes: Buffer.byteLength(text),
        });
      }
    }
  });
  test("line overflow retains head or tail with bounded marker", () => {
    const text = Array.from({ length: 2001 }, (_, i) => `line-${i}`).join("\n");
    const head = truncateHead(text);
    const tail = truncateTail(text);
    expect(head.content.startsWith("line-0\n")).toBe(true);
    expect(head.content).not.toContain("line-2000");
    expect(tail.content.endsWith("line-2000")).toBe(true);
    expect(tail.content).not.toContain("line-0\n");
    for (const result of [head, tail]) {
      expect(result.truncated).toBe(true);
      expect(result.content.split("\n").length).toBe(2000);
      expect(result.outputBytes).toBe(Buffer.byteLength(text));
    }
  });
  test("UTF-8 byte overflow preserves characters and direction", () => {
    const text = `HEAD${"中文🙂".repeat(20000)}TAIL`;
    const head = truncateHead(text);
    const tail = truncateTail(text);
    expect(head.content.startsWith("HEAD")).toBe(true);
    expect(tail.content.endsWith("TAIL")).toBe(true);
    for (const result of [head, tail]) {
      expect(result.content).not.toContain("�");
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(result.truncated).toBe(true);
    }
  });
  test("stream truncation remains visible even when the retained suffix fits", () => {
    expect(truncateTail("final error", 2000, DEFAULT_MAX_BYTES, true).content).toBe(
      "[output truncated; kept tail]\nfinal error",
    );
  });
});
