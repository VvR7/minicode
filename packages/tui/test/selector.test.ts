import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@minicode/protocol";
import {
  canOpenSession,
  createSelectorState,
  formatSelector,
  reduceSelector,
  setSelectorSessions,
} from "../src/selector.ts";

const base: SessionSummary = {
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  mode: "chat",
  status: "idle",
  title: "First",
  workspaceRoot: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestSessionSequence: 0,
};

describe("session selector", () => {
  test("sorts by updatedAt descending then sessionId ascending and wraps selection", () => {
    const newer = {
      ...base,
      sessionId: "650e8400-e29b-41d4-a716-446655440000",
      title: "New",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    let state = setSelectorSessions(createSelectorState(), [base, newer]);
    expect(state.sessions.map((item) => item.title)).toEqual(["New", "First"]);
    state = reduceSelector(state, "up");
    expect(state.selected).toBe(1);
    state = reduceSelector(state, "down");
    expect(state.selected).toBe(0);
  });
  test("toggles filters and marks wrong-workspace, one-shot, and corrupted entries", () => {
    let state = reduceSelector(createSelectorState(), "toggle-workspace");
    state = reduceSelector(state, "toggle-one-shot");
    expect(state).toMatchObject({ allWorkspaces: true, includeOneShot: true });
    const oneShot = { ...base, mode: "one_shot" as const };
    const wrong = { ...base, workspaceRoot: "/other" };
    const corrupted = { ...base, status: "corrupted" as const };
    expect(canOpenSession(oneShot, "/work")).toBe(true);
    expect(canOpenSession(wrong, "/work")).toBe(false);
    expect(canOpenSession(corrupted, "/work")).toBe(false);
    const text = formatSelector(setSelectorSessions(state, [oneShot, wrong, corrupted]), "/work");
    expect(text).toContain("READ ONLY");
    expect(text).toContain("wrong workspace");
    expect(text).toContain("ERROR corrupted");
  });
});
