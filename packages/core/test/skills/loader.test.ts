import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSystemPrompt } from "../../src/agent/system-prompt.ts";
import { ExecutionContext } from "../../src/agent/context.ts";
import { createRunSnapshot } from "../../src/run/snapshot.ts";
import { expandSkillCommand } from "../../src/skills/command.ts";
import { loadSkills } from "../../src/skills/loader.ts";
import { SkillListHandler } from "../../src/handlers/skill-list-handler.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** 为每个用例创建独立的 home/workspace 目录。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minicode-skills-"));
  roots.push(root);
  return { home: join(root, "home"), workspace: join(root, "workspace") };
}
/** 写入可配置 frontmatter 与正文的技能文件。 */
async function skill(root: string, folder: string, text: string) {
  const directory = join(root, folder);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(path, text);
  return path;
}

test("project metadata name overrides global folder names and invalid files are diagnosed", async () => {
  const f = await fixture();
  await skill(
    join(f.home, "skills"),
    "global-folder",
    "---\nname: shared\ndescription: global\n---\nglobal body",
  );
  await skill(
    join(f.home, "skills"),
    "other",
    "---\nname: other\ndescription: |\n  multiline description\n---\nother body",
  );
  const path = await skill(
    join(f.workspace, ".minicode/skills"),
    "project-folder",
    "---\nname: shared\ndescription: project\n---\nproject body",
  );
  await skill(join(f.workspace, ".minicode/skills"), "bad", "---\nname: [broken\n---\nsecret body");
  const catalog = await loadSkills(f.home, f.workspace);
  expect(catalog.skills.map((s) => s.name)).toEqual(["other", "shared"]);
  expect(catalog.skills[1]).toEqual({
    name: "shared",
    description: "project",
    path,
    body: "project body",
  });
  expect(catalog.diagnostics).toHaveLength(1);
  expect(JSON.stringify(catalog.diagnostics)).not.toContain("secret body");
  const handler = new SkillListHandler(f.home);
  const response = await handler.invoke({ workspaceRoot: f.workspace }, {} as never);
  expect(response.kind).toBe("success");
  expect(JSON.stringify(response)).not.toContain("project body");
});

test("prompt advertises metadata only and next load refreshes without changing accepted snapshot", async () => {
  const f = await fixture();
  const path = await skill(
    join(f.home, "skills"),
    "demo",
    "---\nname: demo\ndescription: first\n---\nprivate body",
  );
  const loaded = await loadSystemPrompt(
    "base",
    { global: "global", project: "project" },
    "notes",
    f.home,
    f.workspace,
  );
  const snapshot = createRunSnapshot(loaded.systemPrompt, [], loaded.skillCatalog);
  expect(snapshot.systemPrompt).toContain("available skills:");
  expect(snapshot.systemPrompt).toContain(path);
  expect(snapshot.systemPrompt).not.toContain("private body");
  await writeFile(path, "---\nname: demo\ndescription: next\n---\nnew body");
  const next = await loadSystemPrompt("base", { global: "", project: "" }, "", f.home, f.workspace);
  expect(next.systemPrompt).toContain("next");
  expect(snapshot.skillCatalog?.skills[0]?.body).toBe("private body");
});

test("explicit invocation keeps original command and puts fixed body and multiline arguments in user content", async () => {
  const f = await fixture();
  await skill(
    join(f.home, "skills"),
    "demo",
    "---\nname: demo\ndescription: demo\n---\nbody instructions",
  );
  const catalog = await loadSkills(f.home, f.workspace);
  const command = "/skill demo first\nsecond";
  const expanded = expandSkillCommand(command, catalog);
  expect(expanded.ok).toBe(true);
  if (!expanded.ok) throw new Error("unexpected expansion failure");
  const context = new ExecutionContext({
    sessionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    workspaceRoot: f.workspace,
    goal: command,
    userContent: expanded.userContent ?? [],
  });
  expect(context.goal).toBe(command);
  expect(context.runMessages()[0]?.content).toEqual([...(expanded.userContent ?? [])]);
  expect(JSON.stringify(context.runMessages())).toContain("body instructions");
  expect(expandSkillCommand("normal text", catalog)).toEqual({ ok: true });
  expect(expandSkillCommand("/skill", catalog).ok).toBe(false);
  expect(expandSkillCommand("/skill missing", catalog).ok).toBe(false);
});
