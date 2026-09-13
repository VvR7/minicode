import { z } from "zod";

import {
  AgentCancelRequestSchema,
  AgentCancelSuccessResponseSchema,
  AgentRunRequestSchema,
  AgentRunSuccessResponseSchema,
  EventPushNotificationSchema,
  EventSubscribeRequestSchema,
  EventSubscribeSuccessResponseSchema,
  EventUnsubscribeRequestSchema,
  EventUnsubscribeSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationEnvelopeSchema,
  JsonRpcRequestEnvelopeSchema,
  MAX_JSON_RPC_FRAME_BYTES,
  PingParamsSchema,
  PingRequestSchema,
  PingSuccessResponseSchema,
  PongResultSchema,
} from "../src/index.ts";

const outputUrl = new URL("../../../WIRE_PROTOCOL.md", import.meta.url);

function schemaBlock(name: string, schema: z.ZodType): string {
  return `### ${name}\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n\`\`\``;
}

export function renderWireProtocol(): string {
  const maxFrameMiB = MAX_JSON_RPC_FRAME_BYTES / (1024 * 1024);
  const schemas = [
    schemaBlock("JsonRpcRequestEnvelope", JsonRpcRequestEnvelopeSchema),
    schemaBlock("PingParams", PingParamsSchema),
    schemaBlock("PingRequest", PingRequestSchema),
    schemaBlock("PongResult", PongResultSchema),
    schemaBlock("PingSuccessResponse", PingSuccessResponseSchema),
    schemaBlock("AgentRunRequest", AgentRunRequestSchema),
    schemaBlock("AgentRunSuccessResponse", AgentRunSuccessResponseSchema),
    schemaBlock("AgentCancelRequest", AgentCancelRequestSchema),
    schemaBlock("AgentCancelSuccessResponse", AgentCancelSuccessResponseSchema),
    schemaBlock("EventSubscribeRequest", EventSubscribeRequestSchema),
    schemaBlock("EventSubscribeSuccessResponse", EventSubscribeSuccessResponseSchema),
    schemaBlock("EventUnsubscribeRequest", EventUnsubscribeRequestSchema),
    schemaBlock("EventUnsubscribeSuccessResponse", EventUnsubscribeSuccessResponseSchema),
    schemaBlock("EventPushNotification", EventPushNotificationSchema),
    schemaBlock("JsonRpcNotificationEnvelope", JsonRpcNotificationEnvelopeSchema),
    schemaBlock("JsonRpcErrorResponse", JsonRpcErrorResponseSchema),
  ].join("\n\n");

  return `# Wire Protocol

> Generated from Zod schemas by \`packages/protocol/scripts/generate-wire-protocol.ts\`.
> Do not edit manually; run \`bun run protocol:docs\`.

## Transport

- TCP loopback only: \`127.0.0.1:7437\` by default, configurable with
  \`MINICODE_CORE_HOST\` / \`MINICODE_CORE_PORT\`.
- UTF-8 NDJSON: one non-empty JSON value per LF-terminated frame; CRLF is accepted.
- Maximum payload is ${maxFrameMiB} MiB per frame, excluding the newline delimiter.
- A Core connection accepts multiple requests and may remain open for an event stream.
- Responses and server notifications can be interleaved; clients correlate responses by request ID.

## JSON-RPC profile

- JSON-RPC version \`2.0\` with one request, response, or server notification object per frame.
- Request IDs are non-empty strings or safe integers and are echoed unchanged.
- Client-to-server notifications and batch arrays are not supported and return \`-32600\`.
- Server-to-client \`event.push\` notifications have no request ID and carry one typed agent event.
- Objects are strict: unknown fields are rejected.

## Agent and event stream

- \`agent.run\` accepts a goal and workspace root. Its response identifies the session, run, and
  initial subscription.
- \`agent.cancel\` requests cancellation for one session-isolated run.
- \`event.subscribe\` can resume after a durable sequence cursor; \`event.unsubscribe\` removes a
  subscription.
- The \`agent.run\` response is enqueued before the first \`event.push\` for that run.
- Event sequence numbers are positive and scoped to a run; durable events can be replayed by a
  later event-store implementation.

## Ping

Request:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "core.ping",
  "params": {
    "clientName": "mc-ping",
    "clientVersion": "0.0.1"
  }
}
\`\`\`

Success response:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "serverVersion": "0.0.1",
    "uptimeMs": 12,
    "receivedAt": "2026-09-12T06:00:00.000Z"
  }
}
\`\`\`

## Error codes

| Code | Meaning |
| ---: | --- |
| -32700 | Parse error: invalid JSON, invalid UTF-8, or an empty frame |
| -32600 | Invalid request envelope, unsupported notification/batch, or oversized frame |
| -32601 | Method not found |
| -32602 | Invalid \`core.ping\` parameters |
| -32603 | Internal server error |
| -32001 | Requested run was not found |

## JSON Schemas

${schemas}
`;
}

async function main(): Promise<number> {
  const expected = renderWireProtocol();
  if (Bun.argv.includes("--check")) {
    const file = Bun.file(outputUrl);
    if (!(await file.exists()) || (await file.text()) !== expected) {
      console.error("WIRE_PROTOCOL.md is out of date; run `bun run protocol:docs`");
      return 1;
    }
    return 0;
  }

  await Bun.write(outputUrl, expected);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
