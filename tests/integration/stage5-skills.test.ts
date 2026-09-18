import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreApp } from "../../packages/core/src/index.ts";
import { NdjsonRpcConnection } from "../../packages/client/src/index.ts";
import {
  SKILL_LIST_METHOD,
  SkillListResultSchema,
  SESSION_CREATE_METHOD,
  SessionCreateResultSchema,
  SESSION_SEND_MESSAGE_METHOD,
  SessionSendMessageResultSchema,
  SESSION_GET_HISTORY_METHOD,
  SessionGetHistoryResultSchema,
  SESSION_LIST_METHOD,
  SessionListResultSchema,
} from "../../packages/protocol/src/index.ts";
import { startAnthropicMock } from "./helpers/anthropic-mock.ts";

test("skill catalog is side effect free and invocation survives daemon restart with original expansion", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-stage5-skills-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const directory = join(workspace, ".minicode", "skills", "demo");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(
    path,
    "---\nname: demo\ndescription: demo description\n---\nOriginal skill instructions",
  );
  await writeFile(join(workspace, "README.md"), "demo workspace");
  const mock = startAnthropicMock();
  const environment = {
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: mock.url,
    LLM_MODEL: "test-model",
    LLM_CONTEXT_WINDOW_TOKENS: "100000",
    LLM_MAX_OUTPUT_TOKENS: "4096",
    MINICODE_TRACE_ENABLED: "false",
  };
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    logLevel: "error" as const,
    homeDirectory: home,
  };
  let app = new CoreApp(config, environment);
  let connection = await NdjsonRpcConnection.connect(app.start());
  try {
    const catalog = await connection.request(
      SKILL_LIST_METHOD,
      { workspaceRoot: workspace },
      SkillListResultSchema,
    );
    expect(catalog.result.skills).toEqual([
      { name: "demo", description: "demo description", path },
    ]);
    expect(mock.callCount).toBe(0);
    const sessions = await connection.request(
      SESSION_LIST_METHOD,
      { includeOneShot: true },
      SessionListResultSchema,
    );
    expect(sessions.result.sessions).toHaveLength(0);
    const session = await connection.request(
      SESSION_CREATE_METHOD,
      { workspaceRoot: workspace },
      SessionCreateResultSchema,
    );
    const params = {
      sessionId: session.result.session.sessionId,
      clientMessageId: crypto.randomUUID(),
      content: "/skill demo inspect workspace",
    };
    await expect(
      connection.request(
        SESSION_SEND_MESSAGE_METHOD,
        { ...params, clientMessageId: crypto.randomUUID(), content: "/skill missing" },
        SessionSendMessageResultSchema,
      ),
    ).rejects.toThrow("Invalid params");
    const accepted = await connection.request(
      SESSION_SEND_MESSAGE_METHOD,
      params,
      SessionSendMessageResultSchema,
    );
    const deadline = performance.now() + 5000;
    for (;;) {
      const history = await connection.request(
        SESSION_GET_HISTORY_METHOD,
        { sessionId: params.sessionId },
        SessionGetHistoryResultSchema,
      );
      if (history.result.turns[0]?.status === "succeeded") break;
      if (performance.now() > deadline) throw new Error("skill run did not finish");
      await Bun.sleep(10);
    }
    expect(JSON.stringify(mock.requestBodies[0])).toContain("Original skill instructions");
    expect(JSON.stringify(mock.requestBodies[0])).toContain("available skills:");
    await writeFile(path, "---\nname: demo\ndescription: changed\n---\nChanged skill instructions");
    connection.close();
    await app.stop();
    app = new CoreApp(config, environment);
    connection = await NdjsonRpcConnection.connect(app.start());
    const history = await connection.request(
      SESSION_GET_HISTORY_METHOD,
      { sessionId: params.sessionId },
      SessionGetHistoryResultSchema,
    );
    expect(JSON.stringify(history.result.turns[0]?.messages)).toContain(
      "Original skill instructions",
    );
    expect(JSON.stringify(history.result.turns[0]?.messages)).not.toContain(
      "Changed skill instructions",
    );
    const duplicate = await connection.request(
      SESSION_SEND_MESSAGE_METHOD,
      params,
      SessionSendMessageResultSchema,
    );
    expect(duplicate.result.runId).toBe(accepted.result.runId);
    const refreshed = await connection.request(
      SKILL_LIST_METHOD,
      { workspaceRoot: workspace },
      SkillListResultSchema,
    );
    expect(refreshed.result.skills[0]?.description).toBe("changed");
  } finally {
    connection.close();
    await app.stop();
    await mock.stop();
    await rm(root, { recursive: true, force: true });
  }
});
