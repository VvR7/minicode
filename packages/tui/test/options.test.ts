import { describe, expect, test } from "bun:test";
import { parseTuiArgs } from "../src/options.ts";

describe("parseTuiArgs", () => {
  test("parses all five launch modes", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseTuiArgs([])).toEqual({ ok: true, mode: { kind: "new" } });
    expect(parseTuiArgs(["--goal", " ask "])).toEqual({
      ok: true,
      mode: { kind: "new", goal: "ask" },
    });
    expect(parseTuiArgs(["--continue"])).toEqual({ ok: true, mode: { kind: "continue" } });
    expect(parseTuiArgs(["--session", id])).toEqual({
      ok: true,
      mode: { kind: "session", sessionId: id },
    });
    expect(parseTuiArgs(["--sessions"])).toEqual({ ok: true, mode: { kind: "sessions" } });
  });
  test("rejects conflicts, malformed IDs and invalid goals", () => {
    expect(parseTuiArgs(["--continue", "--sessions"]).ok).toBe(false);
    expect(parseTuiArgs(["--session", "bad"]).ok).toBe(false);
    expect(parseTuiArgs(["--goal", " "]).ok).toBe(false);
    expect(parseTuiArgs(["--goal", "x".repeat(32769)]).ok).toBe(false);
  });
});
