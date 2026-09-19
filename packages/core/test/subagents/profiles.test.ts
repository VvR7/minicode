import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSubagents,
  loadSubagentProfile,
  allowedSubagentTools,
} from "../../src/subagents/profiles.ts";
import { createListSubagentTool } from "../../src/subagents/list-tool.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { z } from "zod";
import { buildRunSnapshot, runToolSchemas } from "../../src/run/runner.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** 创建本用例的独立工作区。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minicode-profiles-"));
  roots.push(root);
  return root;
}
/** 写入项目类型文件，方便验证实时发现。 */
async function profile(workspace: string, name: string, text: string) {
  const directory = join(workspace, ".minicode", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.toml`), text);
}
const document = (description: string, tools: string[] = []) =>
  `[agent]\ndescription=${JSON.stringify(description)}\nsystem_prompt="custom prompt"\nallowed_tools=${JSON.stringify(tools)}`;

test("builtin read-only planning/review and independent executor permissions are advertised through tools", async () => {
  const root = await fixture();
  const catalog = await listSubagents(root);
  expect(catalog.diagnostics).toEqual([]);
  expect(catalog.profiles.map((p) => p.name)).toEqual(["executor", "planner", "reviewer"]);
  expect(catalog.profiles.find((p) => p.name === "planner")?.allowedTools).toEqual(["read"]);
  expect(catalog.profiles.find((p) => p.name === "reviewer")?.allowedTools).toEqual(["read"]);
  expect(catalog.profiles.find((p) => p.name === "executor")?.allowedTools).toContain(
    "task_create",
  );
  expect(catalog.profiles.find((p) => p.name === "executor")?.maxSteps).toBe(40);
  expect(catalog.profiles.find((p) => p.name === "planner")?.maxSteps).toBe(20);
  expect(runToolSchemas().find((t) => t.name === "list_subagent")?.description).toContain(
    "spawn_agent",
  );
  expect(buildRunSnapshot("").systemPrompt).not.toContain(
    catalog.profiles[0]?.description ?? "unexpected",
  );
});

test("project filenames override builtins and each list/spawn lookup refreshes", async () => {
  const root = await fixture();
  await profile(root, "planner", document("custom planner", []));
  await profile(root, "special", document("special type", ["mcp__docs__search"]));
  const first = await listSubagents(root);
  expect(first.profiles.find((p) => p.name === "planner")?.allowedTools).toEqual([]);
  await profile(root, "special", document("updated type", ["read"]));
  expect((await loadSubagentProfile(root, "special")).description).toBe("updated type");
  const result = await createListSubagentTool().execute(
    {},
    { workspaceRoot: root, signal: new AbortController().signal },
  );
  const listed = JSON.parse(result.content) as { agents: { name: string; description: string }[] };
  expect(listed.agents.find((p) => p.name === "special")).toEqual({
    name: "special",
    description: "updated type",
  });
  expect(result.content).not.toContain("custom prompt");
});

test("project profiles accept bounded max_steps and default to twenty", async () => {
  const root = await fixture();
  await profile(root, "default", document("default"));
  await profile(root, "extended", `${document("extended")}\nmax_steps=37`);
  expect((await loadSubagentProfile(root, "default")).maxSteps).toBe(20);
  expect((await loadSubagentProfile(root, "extended")).maxSteps).toBe(37);
});

test("missing required fields and invalid overrides diagnose without falling back", async () => {
  const root = await fixture();
  await profile(root, "reviewer", '[agent]\ndescription="bad"\nsystem_prompt="prompt"');
  await profile(root, "broken", "invalid = [");
  await profile(root, "model", `${document("unsupported model")}\nmodel="another-model"`);
  await profile(root, "zero", `${document("zero")}\nmax_steps=0`);
  await profile(root, "fraction", `${document("fraction")}\nmax_steps=2.5`);
  await profile(root, "excessive", `${document("excessive")}\nmax_steps=101`);
  const catalog = await listSubagents(root);
  expect(catalog.diagnostics).toHaveLength(6);
  expect(catalog.profiles.find((p) => p.name === "reviewer")).toBeUndefined();
  await expect(loadSubagentProfile(root, "reviewer")).rejects.toThrow("unknown or invalid");
  await expect(loadSubagentProfile(root, "absent")).rejects.toThrow("unknown or invalid");
});

test("strict whitelist supports exact MCP names, no tools and rejects unknown/nested delegation", async () => {
  const root = await fixture();
  const registry = new ToolRegistry();
  const tool = {
    name: "mcp__docs__search",
    description: "search",
    inputSchema: z.record(z.string(), z.unknown()),
    async execute() {
      return { content: "ok" };
    },
  };
  registry.register(tool);
  await profile(root, "special", document("special", [tool.name]));
  const loaded = await loadSubagentProfile(root, "special");
  expect(allowedSubagentTools(loaded, registry)).toEqual([tool]);
  expect(allowedSubagentTools({ ...loaded, allowedTools: [] }, registry)).toEqual([]);
  expect(() =>
    allowedSubagentTools({ ...loaded, allowedTools: ["mcp__docs__*"] }, registry),
  ).toThrow("unknown allowed tool");
  for (const name of ["spawn_agent", "agent_result", "list_subagent"])
    expect(() => allowedSubagentTools({ ...loaded, allowedTools: [name] }, registry)).toThrow(
      "forbidden",
    );
});
