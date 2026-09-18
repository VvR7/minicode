import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreApp, EventStore } from "../../packages/core/src/index.ts";
import { SessionStore } from "../../packages/core/src/session/session-store.ts";
import { SessionController, type SessionControllerEvent } from "../../packages/client/src/index.ts";
import { startScriptedAnthropicMock, createBarrier } from "./helpers/scripted-anthropic-mock.ts";
/** 等待跨进程状态的实际切点，测试只使用临时目录和本地服务。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Stage5 lifecycle timed out");
    await Bun.sleep(5);
  }
}
interface Part {
  type: string;
  text?: string;
  content?: string;
  tool_use_id?: string;
  name?: string;
}
interface RequestBody {
  system: string;
  messages: { content: Part[] }[];
  tools: { name: string; input_schema: unknown }[];
}

/** 同一 Core 的两个工作区、后台子 Agent、Skill 展开与真实 MCP 子进程组合验收。 */
test("complete Stage5 lifecycle combines skills, background subagents, MCP concurrency and isolated replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-stage5-combo-"));
  const homeDirectory = join(root, "home");
  await mkdir(join(homeDirectory, "skills/combo"), { recursive: true });
  await mkdir(join(homeDirectory, "skills/common"), { recursive: true });
  await Bun.write(
    join(homeDirectory, "skills/combo/SKILL.md"),
    "---\nname: combo\ndescription: GLOBAL_FALLBACK\n---\nGLOBAL_PRIVATE_BODY\n",
  );
  await Bun.write(
    join(homeDirectory, "skills/common/SKILL.md"),
    "---\nname: common\ndescription: COMMON_AVAILABLE\n---\nCOMMON_PRIVATE_BODY\n",
  );
  await Bun.write(join(homeDirectory, "CONTEXT.md"), "GLOBAL_FIXED_RULE");
  await Bun.write(
    join(homeDirectory, "config.toml"),
    '[[mcp.servers]]\nname="fixture"\ntransport="stdio"\ncommand="global-config-must-be-overridden"\n',
  );
  const workspaces = [join(root, "A"), join(root, "B")];
  for (const [index, workspace] of workspaces.entries()) {
    const label = index === 0 ? "A" : "B";
    await mkdir(join(workspace, ".minicode/skills/combo"), { recursive: true });
    await mkdir(join(workspace, ".minicode/agents"), { recursive: true });
    await Bun.write(join(workspace, "CONTEXT.md"), `RULE_${label}`);
    await Bun.write(
      join(workspace, ".minicode/skills/combo/SKILL.md"),
      `---\nname: combo\ndescription: PROJECT_SKILL_${label}\n---\nPROJECT_BODY_${label}\n`,
    );
    await Bun.write(
      join(workspace, ".minicode/agents/worker.toml"),
      '[agent]\ndescription="combined worker"\nsystem_prompt="WORKER_ROLE"\nallowed_tools=["read","mcp__fixture__echo"]\n',
    );
    await Bun.write(
      join(workspace, ".minicode/config.toml"),
      `[[mcp.servers]]\nname="fixture"\ntransport="stdio"\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(import.meta.dir, "fixtures/stage5-mcp.ts"))},${JSON.stringify(join(root, `mcp-${label}.jsonl`))}]\n`,
    );
  }
  const childBarrier = createBarrier();
  const mock = startScriptedAnthropicMock((body) => {
    const data = body as RequestBody;
    const label = data.system.includes("RULE_A") ? "A" : "B";
    const child = data.system.includes("WORKER_ROLE");
    if (child) {
      if (data.messages.at(-1)?.content.some((part) => part.type === "tool_result"))
        return {
          kind: "text",
          chunks: [`CHILD_DONE_${label}`],
          ...(data.messages[0]?.content.some((part) => part.text?.includes("cancel"))
            ? { barrier: childBarrier, afterChunks: 1 }
            : {}),
        };
      return {
        kind: "tools",
        calls: [
          { id: "child-mcp-1", name: "mcp__fixture__echo", input: { label: `${label}-child-1` } },
          { id: "child-mcp-2", name: "mcp__fixture__echo", input: { label: `${label}-child-2` } },
          { id: "skill-read", name: "read", input: { path: ".minicode/skills/combo/SKILL.md" } },
        ],
      };
    }
    const anchor = data.messages.findLastIndex((message) =>
      message.content.some((part) => part.text?.startsWith("/skill combo")),
    );
    const current = data.messages.slice(anchor);
    if (
      current.some((message) =>
        message.content.some((part) => part.text?.startsWith("Subagent result:")),
      )
    )
      return { kind: "text", chunks: [`INTEGRATED_${label}`] };
    if (current.at(-1)?.content.some((part) => part.type === "tool_result"))
      return { kind: "text", chunks: [`CANDIDATE_${label}`] };
    const cancel = current[0]?.content.some((part) => part.text?.includes("cancel"));
    return {
      kind: "tools",
      calls: [
        {
          id: "spawn",
          name: "spawn_agent",
          input: {
            name: "worker",
            goal: `CHILD_${label}${cancel ? " cancel" : ""}`,
            context: `EXPLICIT_${label}`,
            background: true,
          },
        },
        { id: "parent-mcp-1", name: "mcp__fixture__echo", input: { label: `${label}-parent-1` } },
        { id: "parent-mcp-2", name: "mcp__fixture__echo", input: { label: `${label}-parent-2` } },
      ],
    };
  });
  const config = { host: "127.0.0.1" as const, port: 0, logLevel: "error" as const, homeDirectory };
  const environment = {
    LLM_API_KEY: "fixture",
    LLM_BASE_URL: mock.url,
    LLM_MODEL: "fixture",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    MINICODE_TRACE_ENABLED: "false",
  };
  const app = new CoreApp(config, environment);
  const endpoint = app.start();
  const events: SessionControllerEvent[][] = [[], [], []];
  const clients = events.map(
    (observed) =>
      new SessionController({
        endpoint,
        onEvent: (event) => {
          observed.push(event);
        },
      }),
  );
  const a = clients[0];
  const b = clients[1];
  const mirror = clients[2];
  if (!a || !b || !mirror) throw new Error("missing clients");
  const restarted = new CoreApp(config, environment);
  let restored: SessionController | undefined;
  try {
    const workspaceA = workspaces[0];
    const workspaceB = workspaces[1];
    if (!workspaceA || !workspaceB) throw new Error("missing workspaces");
    const [sessionA, sessionB] = await Promise.all([a.create(workspaceA), b.create(workspaceB)]);
    await mirror.attach(sessionA.sessionId);
    const skills = await a.listSkills();
    expect(skills.skills.map((skill) => skill.name)).toEqual(["combo", "common"]);
    expect(skills.skills.find((skill) => skill.name === "combo")?.path).toBe(
      join(workspaceA, ".minicode/skills/combo/SKILL.md"),
    );
    const [runA, runB] = await Promise.all([
      a.sendMessage("/skill combo A arguments"),
      b.sendMessage("/skill combo B arguments"),
    ]);
    await waitFor(
      () =>
        a.permissions.length === 1 && b.permissions.length === 1 && mirror.permissions.length === 1,
    );
    const permissionA = a.permissions[0]?.request;
    const permissionB = b.permissions[0]?.request;
    if (!permissionA || !permissionB) throw new Error("missing MCP approvals");
    expect(permissionA.payload.name).toBe("mcp__fixture__echo");
    expect(permissionB.payload.name).toBe("mcp__fixture__echo");
    expect(permissionA.payload.permissionRequestId).not.toBe(
      permissionB.payload.permissionRequestId,
    );
    expect(mirror.permissions[0]?.request.payload.permissionRequestId).toBe(
      permissionA.payload.permissionRequestId,
    );
    await Promise.all([
      mirror.respondPermission(runA.runId, permissionA.payload.permissionRequestId, "always_allow"),
      b.respondPermission(runB.runId, permissionB.payload.permissionRequestId, "always_allow"),
    ]);
    await waitFor(
      () =>
        events[0]?.some((e) => e.type === "turn.committed" && e.runId === runA.runId) === true &&
        events[1]?.some((e) => e.type === "turn.committed" && e.runId === runB.runId) === true &&
        events[2]?.some((e) => e.type === "turn.committed" && e.runId === runA.runId) === true,
    );
    for (const [index, run] of [runA, runB].entries()) {
      const label = index === 0 ? "A" : "B";
      const workspace = workspaces[index];
      const session = index === 0 ? sessionA : sessionB;
      const loaded = await new SessionStore(homeDirectory).load(session.sessionId);
      expect(loaded.ok && loaded.value.turns[0]?.messages[0]?.content[0]).toMatchObject({
        type: "text",
        text: `/skill combo ${label} arguments`,
      });
      expect(loaded.ok && loaded.value.turns[0]?.status).toBe("succeeded");
      expect(loaded.ok && loaded.value.turns[0]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: `INTEGRATED_${label}` },
      ]);
      const parent = await new EventStore(homeDirectory).read(session.sessionId, run.runId);
      if (!parent.ok) throw new Error("parent audit missing");
      expect(parent.value.events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
      const childStart = parent.value.events.find((e) => e.type === "subagent.started");
      if (childStart?.type !== "subagent.started") throw new Error("missing child lifecycle");
      const childId = childStart.payload.childRunId;
      const child = await new EventStore(homeDirectory, undefined, run.runId).read(
        session.sessionId,
        childId,
      );
      expect(child.ok && child.value.finished).toBe(true);
      const bodies = mock.requestBodies as readonly RequestBody[];
      const own = bodies.filter((body) => body.system.includes(`RULE_${label}`));
      expect(
        own.every((body) => !JSON.stringify(body).includes(`RULE_${label === "A" ? "B" : "A"}`)),
      ).toBe(true);
      const firstParent = own.find((body) => !body.system.includes("WORKER_ROLE"));
      expect(JSON.stringify(firstParent?.messages)).toContain(`PROJECT_BODY_${label}`);
      expect(JSON.stringify(firstParent?.messages)).toContain(`${label} arguments`);
      expect(firstParent?.system).toContain("COMMON_AVAILABLE");
      expect(JSON.stringify(own)).not.toContain("GLOBAL_PRIVATE_BODY");
      const childBodies = own.filter((body) => body.system.includes("WORKER_ROLE"));
      expect(
        childBodies.every(
          (body) =>
            body.tools
              .map((tool) => tool.name)
              .sort()
              .join(",") === "mcp__fixture__echo,read",
        ),
      ).toBe(true);
      expect(JSON.stringify(childBodies)).not.toContain(`/skill combo ${label} arguments`);
      expect(JSON.stringify(childBodies)).toContain(`EXPLICIT_${label}`);
      for (const kind of ["parent", "child"])
        for (const suffix of ["1", "2"]) {
          const result = own
            .flatMap((body) => body.messages)
            .flatMap((message) => message.content)
            .find(
              (part) => part.type === "tool_result" && part.tool_use_id === `${kind}-mcp-${suffix}`,
            );
          expect(result?.content).toContain(`echo:${label}-${kind}-${suffix}`);
        }
      const activity = (await readFile(join(root, `mcp-${label}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; inFlight?: number; cwd?: string });
      expect(
        activity.filter((line) => line.kind === "start").every((line) => line.cwd === workspace),
      ).toBe(true);
      expect(Math.max(...activity.map((line) => line.inFlight ?? 0))).toBeGreaterThanOrEqual(2);
    }
    expect(
      events[0]
        ?.filter((e) => e.type === "run.event")
        .every((e) => e.type !== "run.event" || e.event.sessionId === sessionA.sessionId),
    ).toBe(true);
    expect(
      events[1]
        ?.filter((e) => e.type === "run.event")
        .every((e) => e.type !== "run.event" || e.event.sessionId === sessionB.sessionId),
    ).toBe(true);
    const mirrorLifecycle = events[2]?.flatMap((e) =>
      e.type === "run.event" && e.event.type.startsWith("subagent.") ? [e.event.type] : [],
    );
    expect(mirrorLifecycle).toEqual(["subagent.started", "subagent.finished"]);
    const cancel = await a.sendMessage("/skill combo cancel");
    await childBarrier.reached;
    await a.cancelActiveRun();
    await waitFor(
      () =>
        events[0]?.some((e) => e.type === "turn.committed" && e.runId === cancel.runId) === true,
    );
    const cancelled = await new SessionStore(homeDirectory).load(sessionA.sessionId);
    expect(cancelled.ok && cancelled.value.turns.at(-1)?.status).toBe("cancelled");
    childBarrier.release();
    await Promise.all(clients.map((client) => client.dispose()));
    await app.stop();
    for (const label of ["A", "B"]) {
      const firstLine = (await readFile(join(root, `mcp-${label}.jsonl`), "utf8")).split("\n")[0];
      const pid = (JSON.parse(firstLine ?? "{}") as { pid: number }).pid;
      expect(() => process.kill(pid, 0)).toThrow();
    }
    const markerChild = crypto.randomUUID();
    const markerDirectory = join(
      homeDirectory,
      "sessions",
      sessionA.sessionId,
      "runs",
      cancel.runId,
      "subagents",
      markerChild,
    );
    await mkdir(markerDirectory, { recursive: true });
    await Bun.write(
      join(markerDirectory, "state.json"),
      JSON.stringify({
        childRunId: markerChild,
        name: "worker",
        background: true,
        status: "running",
      }),
    );
    restored = new SessionController({ endpoint: restarted.start(), onEvent() {} });
    await restored.attach(sessionA.sessionId);
    expect(JSON.parse(await readFile(join(markerDirectory, "state.json"), "utf8")).status).toBe(
      "interrupted",
    );
    expect(restored.permissions).toHaveLength(0);
  } finally {
    childBarrier.release();
    await restored?.dispose();
    await Promise.all(clients.map((client) => client.dispose()));
    await app.stop();
    await restarted.stop();
    await mock.stop();
    await rm(root, { recursive: true, force: true });
  }
});
