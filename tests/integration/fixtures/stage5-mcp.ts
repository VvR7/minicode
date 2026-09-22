import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = process.argv[2];
if (!marker) throw new Error("fixture marker required");
writeFileSync(
  marker,
  `${JSON.stringify({ kind: "init", pid: process.pid, cwd: process.cwd() })}\n`,
);
let inFlight = 0;
/** 独立按请求 ID 返回结果，不阻塞下一条输入，供跨进程并发关联验收。 */
function reply(id: number | string, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as {
    id?: number | string;
    method: string;
    params?: { arguments?: { label?: string } };
  };
  if (request.id === undefined) continue;
  if (request.method === "initialize")
    reply(request.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "stage5-fixture", version: "1" },
    });
  else if (request.method === "tools/list")
    reply(request.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a labeled request in the current workspace",
          inputSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: false,
          },
        },
      ],
    });
  else if (request.method === "tools/call") {
    const id = request.id;
    const label = request.params?.arguments?.label ?? "";
    inFlight++;
    appendFileSync(
      marker,
      `${JSON.stringify({ kind: "start", label, inFlight, cwd: process.cwd() })}\n`,
    );
    setTimeout(
      () => {
        reply(id, {
          content: [{ type: "text", text: `echo:${label}` }],
          structuredContent: { label, cwd: process.cwd() },
        });
        inFlight--;
        appendFileSync(marker, `${JSON.stringify({ kind: "end", label, inFlight })}\n`);
      },
      label.endsWith("1") ? 30 : 5,
    );
  } else reply(request.id, {});
}
