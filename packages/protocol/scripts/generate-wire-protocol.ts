import { z } from "zod";

import {
  AgentCancelRequestSchema,
  AgentCancelSuccessResponseSchema,
  AgentEventSchema,
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
  PermissionRespondRequestSchema,
  PermissionRespondSuccessResponseSchema,
  PingParamsSchema,
  PingRequestSchema,
  PingSuccessResponseSchema,
  PongResultSchema,
  SessionCompactRequestSchema,
  SessionCompactSuccessResponseSchema,
  SessionCreateRequestSchema,
  SessionCreateSuccessResponseSchema,
  SessionEventSchema,
  SessionGetHistoryRequestSchema,
  SessionGetHistorySuccessResponseSchema,
  SessionGetRequestSchema,
  SessionGetSuccessResponseSchema,
  SessionListRequestSchema,
  SessionListSuccessResponseSchema,
  SessionSendMessageRequestSchema,
  SessionSendMessageSuccessResponseSchema,
  SessionSubscribeRequestSchema,
  SessionSubscribeSuccessResponseSchema,
  SessionSummarySchema,
  SkillListRequestSchema,
  SkillListSuccessResponseSchema,
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
    schemaBlock("PermissionRespondRequest", PermissionRespondRequestSchema),
    schemaBlock("PermissionRespondSuccessResponse", PermissionRespondSuccessResponseSchema),
    schemaBlock("SkillListRequest", SkillListRequestSchema),
    schemaBlock("SkillListSuccessResponse", SkillListSuccessResponseSchema),
    schemaBlock("AgentEvent", AgentEventSchema),
    schemaBlock("EventSubscribeRequest", EventSubscribeRequestSchema),
    schemaBlock("EventSubscribeSuccessResponse", EventSubscribeSuccessResponseSchema),
    schemaBlock("EventUnsubscribeRequest", EventUnsubscribeRequestSchema),
    schemaBlock("EventUnsubscribeSuccessResponse", EventUnsubscribeSuccessResponseSchema),
    schemaBlock("SessionSummary", SessionSummarySchema),
    schemaBlock("SessionCompactRequest", SessionCompactRequestSchema),
    schemaBlock("SessionCompactSuccessResponse", SessionCompactSuccessResponseSchema),
    schemaBlock("SessionCreateRequest", SessionCreateRequestSchema),
    schemaBlock("SessionCreateSuccessResponse", SessionCreateSuccessResponseSchema),
    schemaBlock("SessionGetRequest", SessionGetRequestSchema),
    schemaBlock("SessionGetSuccessResponse", SessionGetSuccessResponseSchema),
    schemaBlock("SessionListRequest", SessionListRequestSchema),
    schemaBlock("SessionListSuccessResponse", SessionListSuccessResponseSchema),
    schemaBlock("SessionSendMessageRequest", SessionSendMessageRequestSchema),
    schemaBlock("SessionSendMessageSuccessResponse", SessionSendMessageSuccessResponseSchema),
    schemaBlock("SessionGetHistoryRequest", SessionGetHistoryRequestSchema),
    schemaBlock("SessionGetHistorySuccessResponse", SessionGetHistorySuccessResponseSchema),
    schemaBlock("SessionSubscribeRequest", SessionSubscribeRequestSchema),
    schemaBlock("SessionSubscribeSuccessResponse", SessionSubscribeSuccessResponseSchema),
    schemaBlock("SessionEvent", SessionEventSchema),
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
- Server-to-client \`event.push\` notifications have no request ID and carry one typed run or session event.
- Objects are strict: unknown fields are rejected.

## Agent and event stream

- \`agent.run\` accepts a goal and workspace root. Its response identifies the session, run, and
  initial subscription.
- \`agent.cancel\` requests cancellation for one session-isolated run.
- \`event.subscribe\` can resume after a durable sequence cursor; \`event.unsubscribe\` removes a
  subscription.
- \`permission.respond\` resolves one Core-generated, session/run-scoped permission request. Its
  result distinguishes an accepted response from an already resolved or unknown request.
- The \`agent.run\` response is enqueued before the first \`event.push\` for that run.
- Event sequence numbers are positive and scoped to a run; durable events can be replayed by a
  reconnecting client through the run journal.

## Stage3 permission lifecycle

- Core validates strict tool arguments before policy evaluation or approval. General tools are
  read/write/edit/bash; task and note tools remain available. Old tool names are history-only.
- Durable permission.requested events contain bounded summaries, not full write/edit content.
  Responses require an attached connection and matching session/run/Core-generated request ID.
- Decisions are allow_once, deny_once, always_allow, and always_deny. Always decisions cache one
  risk category in daemon memory for that session only; composite risks accept once decisions only.
  Forced policy denial cannot be overridden by the cache.
- The first valid response claims the request; Core persists permission.resolved before releasing
  execution. accepted is not a client-side resolved event. Repeats return already_resolved;
  unknown, mismatched, unattached, or ineligible always responses return not_found.
- Approval has no timeout and does not consume tool execution time. Tool retries are durable,
  bounded to three attempts with cancellable 2/4-second backoff for explicitly transient runtime
  failures or tool rate limits; schema errors, denial, timeout, and deterministic failures do not retry.
- Tool failures remain observations. Cancellation/shutdown closes pending approval without a fake
  user decision; restart repairs terminal journals but never resumes tools or restores approval cache.
- Completed run approvals replay through event.subscribe; chat history alone is not a pending
  approval queue. Stage2 persisted events/history remain readable without executing old tool names.
- workspaceRoot is a relative-path base, not a filesystem sandbox: absolute/external symlink paths
  are permitted. Bash classification is heuristic, not a shell parser or security isolation layer.
  See [Stage3 permissions](STAGE3_PERMISSIONS.md) and [test matrix](STAGE3_TEST_MATRIX.md).

## Stage4 compaction contracts

- \`session.compact\` accepts a session ID and optional focus, without creating a turn.
- A compacted result identifies a summary or fallback checkpoint and the first retained message;
  unchanged results omit the checkpoint. Busy sessions reject manual compaction.
- Durable session.compaction_started/finished/failed events share the session sequence domain.
- Context message metadata is optional for old history; summary and fallback kinds identify
  compaction messages. Provider messages exclude this metadata.
- Core implements persisted incremental checkpoints, automatic threshold/context-error compaction,
  and idle manual compaction. TUI exposes \`/compact [focus]\`; CLI reports automatic progress on stderr.

## Stage5 extension contracts

- \`skill.list\` defines a workspace-scoped catalog response with name, description, SKILL.md path,
  and bounded diagnostics. Handler registration and command expansion arrive with Skills support;
  this contract alone does not enable the method on Core.
- Durable \`subagent.started\` / \`subagent.finished\` events belong to the parent session/run and carry
  the isolated childRunId, profile name, background flag, and bounded terminal summary. Child task
  events do not belong to the parent's task graph.
- Permission summaries support MCP server/tool identity and a bounded, publisher-redacted parameter
  preview. Requested/resolved events may carry childRunId without changing the parent run scope.
  Legacy events without childRunId remain valid. MCP approval policy is implemented with MCP tools.
- Core prepares a fixed system prompt/tool-schema snapshot before allocating turn/run IDs, then
  reuses it for the provider, tracing, and compaction budget checks. Tools may export an original
  JSON Schema while retaining local Zod validation.
- Tools may declare serial/parallel execution mode (default parallel). This foundation keeps the
  existing sequential loop; batch scheduling is delivered separately. An explicit null execution
  timeout disables only the tool timer, preserving external cancellation and provider timeouts.

## Sessions

- Session RPCs are additive: \`agent.run\` keeps its Stage1 shape as the one-shot test entry point.
- \`session.create\` opens a chat session rooted at a normalized workspace path.
- \`session.sendMessage\` is idempotent per \`clientMessageId\`: a retry with the same id and content
  returns the original \`turnId\`/\`runId\`, while a different content for the same id is rejected.
- \`session.list\` defaults to \`includeOneShot=false\` and \`limit=50\` (max 100); results are ordered
  by \`updatedAt\` descending, then \`sessionId\` ascending, and paged with an opaque \`cursor\`.
- \`session.subscribe\` reuses \`event.unsubscribe\` and replays session events after \`afterSequence\`;
  \`sessionSequence\` is an independent domain from run \`sequence\`.
- Session events (\`session.turn_accepted\`, \`session.turn_finished\`) always carry a \`sessionId\`;
  run events always carry \`sessionId\`, \`runId\`, and a run \`sequence\`.
- Task planning is run-scoped: \`task.created\` and \`task.updated\` carry a \`revision\` plus a full
  \`TaskSnapshot\`, and never use a global event scope.
- Only successful, completely paired history enters the next turn context; failed, cancelled, and
  interrupted turns remain auditable but are excluded. Session notes persist, while TaskManager is
  recreated empty for every run.
- A context-budget rejection returns \`-32013\` before allocating a turn ID, run ID, or run directory.
- Consumers merge session and run journals by identity plus their independent sequence domains;
  timestamps and coincidentally equal text are not deduplication keys.

\`agent.run\` request (the response identifies the session, run, and initial subscription):

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "method": "agent.run",
  "params": {
    "goal": "Summarize the README",
    "workspaceRoot": "/absolute/path/to/workspace"
  }
}
\`\`\`

## Ping

Request:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "core.ping",
  "params": {
    "clientName": "mc-ping",
    "clientVersion": "0.1.0"
  }
}
\`\`\`

Success response:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "serverVersion": "0.1.0",
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
| -32602 | Invalid \`core.ping\`, \`agent.*\`, or \`session.*\` parameters |
| -32603 | Internal server error |
| -32001 | Requested run was not found |
| -32010 | \`session_not_found\` |
| -32011 | \`session_busy\` (another turn already owns the session) |
| -32012 | \`session_corrupted\` (read-only, diagnostic) |
| -32013 | \`context_limit_exceeded\` (rejected before any turn/run is created) |
| -32014 | \`one_shot_not_resumable\` (one-shot sessions cannot accept new messages) |

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
