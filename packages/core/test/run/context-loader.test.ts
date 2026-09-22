import { describe, expect, test } from "bun:test";
import { loadContextFiles } from "../../src/memory/context-loader.ts";
import { composeSystemPrompt } from "../../src/agent/system-prompt.ts";
import { MemorySessionStorage, createMemoryStore } from "../session/test-helpers.ts";

describe("layered context files", () => {
  test("loads only global and exact workspace root and refreshes each snapshot", async () => {
    const storage = new MemorySessionStorage();
    storage.files.set("/home/CONTEXT.md", " global ");
    storage.files.set("/project/CONTEXT.md", " project ");
    storage.files.set("/CONTEXT.md", "ancestor");
    storage.files.set("/project/nested/CONTEXT.md", "nested");
    const first = await loadContextFiles("/home", "/project", storage);
    expect(first).toEqual({ global: "global", project: "project" });
    storage.files.set("/project/CONTEXT.md", "changed");
    expect(first.project).toBe("project");
    expect((await loadContextFiles("/home", "/project", storage)).project).toBe("changed");
    expect((await loadContextFiles("/home", "/other", storage)).project).toBe("");
  });
  test("missing and blank files are ignored while read failures are surfaced", async () => {
    const { storage, store } = createMemoryStore("/home");
    storage.files.set("/project/CONTEXT.md", " \n ");
    expect(await loadContextFiles("/home", "/project", storage)).toEqual({
      global: "",
      project: "",
    });
    expect((await store.loadContextFiles("/project")).ok).toBe(true);
    storage.readError = new Error("private path details");
    await expect(loadContextFiles("/home", "/project", storage)).rejects.toThrow();
    expect(await store.loadContextFiles("/project")).toEqual({
      ok: false,
      error: { code: "io_error", message: "failed to read CONTEXT.md" },
    });
  });
  test("composition preserves ordering and project precedence", () => {
    const prompt = composeSystemPrompt("base", { global: "GLOBAL", project: "PROJECT" }, "NOTES");
    expect(prompt.indexOf("GLOBAL")).toBeLessThan(prompt.indexOf("PROJECT"));
    expect(prompt.indexOf("PROJECT")).toBeLessThan(prompt.indexOf("NOTES"));
    expect(prompt).toContain("Project context takes precedence");
    const empty = composeSystemPrompt("base", { global: "", project: "" }, " \n");
    expect(empty).toStartWith("base\n\n## available skills:\n(none)");
    expect(empty).not.toContain("Session Notes");
  });
});
