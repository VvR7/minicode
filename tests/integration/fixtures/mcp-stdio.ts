import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const marker = process.argv[2];
const { FIXTURE_TOKEN } = process.env;
if (marker)
  writeFileSync(
    marker,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), token: FIXTURE_TOKEN }),
  );
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: { cursor?: string } };
  if (request.id === undefined) continue;
  let result: unknown;
  if (request.method === "initialize")
    result = {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0" },
    };
  else if (request.method === "tools/list")
    result =
      request.params?.cursor === "second"
        ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "second" };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: "echo" }] };
  else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
