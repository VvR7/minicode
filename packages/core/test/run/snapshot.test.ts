import { describe, expect, test } from "bun:test";

import { buildRunSnapshot, runToolSchemas } from "../../src/run/runner.ts";
import { createRunSnapshot, RunSnapshotSchema } from "../../src/run/snapshot.ts";

describe("RunSnapshot", () => {
  test("copies external schema data so source edits cannot change an accepted run", () => {
    const source = {
      name: "mcp__docs__search",
      description: "Search documents",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    };
    const snapshot = createRunSnapshot("fixed rules", [source]);
    source.description = "changed";
    source.inputSchema.properties.query.type = "number";
    expect(snapshot.toolSchemas[0]).toEqual({
      name: "mcp__docs__search",
      description: "Search documents",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    });
    expect(snapshot.systemPrompt).toBe("fixed rules");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.toolSchemas)).toBe(true);
  });

  test("defaults include the existing layered prompt and builtin tool catalog", () => {
    const snapshot = buildRunSnapshot("note", { global: "global rules", project: "project rules" });
    expect(snapshot.systemPrompt).toContain("global rules");
    expect(snapshot.systemPrompt).toContain("project rules");
    expect(snapshot.systemPrompt).toContain("note");
    expect(snapshot.toolSchemas).toEqual(runToolSchemas());
    expect(buildRunSnapshot("").systemPrompt).not.toContain("Session Notes");
  });

  test("rejects invalid tool definitions and unexpected snapshot fields", () => {
    expect(() =>
      createRunSnapshot("rules", [{ name: "", description: "", inputSchema: {} }]),
    ).toThrow();
    expect(
      RunSnapshotSchema.safeParse({
        systemPrompt: "rules",
        toolSchemas: [],
        runId: "not-allocated",
      }).success,
    ).toBe(false);
  });
});
