import { describe, expect, test } from "bun:test";

import { parseTuiArgs } from "../src/options.ts";

describe("parseTuiArgs", () => {
  test("parses --goal with a separate value", () => {
    expect(parseTuiArgs(["--goal", "summarize"])).toEqual({ ok: true, goal: "summarize" });
  });

  test("parses --goal=value form and trims", () => {
    expect(parseTuiArgs(["--goal=  hello  "])).toEqual({ ok: true, goal: "hello" });
  });

  test("rejects missing, empty, and unknown arguments", () => {
    expect(parseTuiArgs([]).ok).toBe(false);
    expect(parseTuiArgs(["--goal", ""]).ok).toBe(false);
    expect(parseTuiArgs(["--goal"]).ok).toBe(false);
    expect(parseTuiArgs(["--unknown"]).ok).toBe(false);
  });

  test("rejects an over-long goal via the protocol schema", () => {
    const tooLong = "x".repeat(33 * 1024);
    expect(parseTuiArgs(["--goal", tooLong]).ok).toBe(false);
  });
});
