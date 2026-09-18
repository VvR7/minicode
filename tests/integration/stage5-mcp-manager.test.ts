import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerManager } from "../../packages/core/src/mcp/server-manager.ts";

test("official SDK discovers all stdio/HTTP pages, sends headers and closes owned process", async () => {
  const root = await mkdtemp(join(tmpdir(), "minicode-mcp-sdk-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const marker = join(root, "marker.json");
  const auth: (string | null)[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      auth.push(request.headers.get("authorization"));
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1.0" },
            }
          : body.method === "tools/list"
            ? body.params?.cursor === "second"
              ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
              : {
                  tools: [{ name: "first", inputSchema: { type: "object" } }],
                  nextCursor: "second",
                }
            : { content: [{ type: "text", text: "http echo" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  await writeFile(
    join(root, "config.toml"),
    `[[mcp.servers]]\nname="local"\ntransport="stdio"\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(import.meta.dir, "fixtures/mcp-stdio.ts"))},${JSON.stringify(marker)}]\n[mcp.servers.env]\nFIXTURE_TOKEN="\${TOKEN}"\n[[mcp.servers]]\nname="remote"\ntransport="http"\nurl="http://127.0.0.1:${http.port}/mcp"\n[mcp.servers.headers]\nAuthorization="Bearer \${TOKEN}"\n`,
  );
  const manager = new McpServerManager(root, { TOKEN: "fixture-secret" });
  try {
    const snapshot = await manager.forWorkspace(workspace);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.servers.map((s) => s.tools.map((t) => t.name))).toEqual([
      ["first", "second"],
      ["first", "second"],
    ]);
    const processInfo = JSON.parse(await readFile(marker, "utf8")) as {
      pid: number;
      cwd: string;
      token: string;
    };
    expect(processInfo.cwd).toBe(workspace);
    expect(processInfo.token).toBe("fixture-secret");
    expect(auth.length).toBeGreaterThan(2);
    expect(auth.every((value) => value === "Bearer fixture-secret")).toBe(true);
    expect(
      await snapshot.servers[1]?.client.callTool("first", {}, new AbortController().signal),
    ).toMatchObject({ content: [{ type: "text", text: "http echo" }] });
    await manager.close();
    expect(() => process.kill(processInfo.pid, 0)).toThrow();
  } finally {
    await manager.close();
    await http.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
