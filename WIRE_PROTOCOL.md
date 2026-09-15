# Wire Protocol

> Generated from Zod schemas by `packages/protocol/scripts/generate-wire-protocol.ts`.
> Do not edit manually; run `bun run protocol:docs`.

## Transport

- TCP loopback only: `127.0.0.1:7437` by default, configurable with
  `MINICODE_CORE_HOST` / `MINICODE_CORE_PORT`.
- UTF-8 NDJSON: one non-empty JSON value per LF-terminated frame; CRLF is accepted.
- Maximum payload is 1 MiB per frame, excluding the newline delimiter.
- A Core connection accepts multiple requests and may remain open for an event stream.
- Responses and server notifications can be interleaved; clients correlate responses by request ID.

## JSON-RPC profile

- JSON-RPC version `2.0` with one request, response, or server notification object per frame.
- Request IDs are non-empty strings or safe integers and are echoed unchanged.
- Client-to-server notifications and batch arrays are not supported and return `-32600`.
- Server-to-client `event.push` notifications have no request ID and carry one typed run or session event.
- Objects are strict: unknown fields are rejected.

## Agent and event stream

- `agent.run` accepts a goal and workspace root. Its response identifies the session, run, and
  initial subscription.
- `agent.cancel` requests cancellation for one session-isolated run.
- `event.subscribe` can resume after a durable sequence cursor; `event.unsubscribe` removes a
  subscription.
- The `agent.run` response is enqueued before the first `event.push` for that run.
- Event sequence numbers are positive and scoped to a run; durable events can be replayed by a
  later event-store implementation.

## Sessions

- Session RPCs are additive: `agent.run` keeps its Stage1 shape as the one-shot test entry point.
- `session.create` opens a chat session rooted at a normalized workspace path.
- `session.sendMessage` is idempotent per `clientMessageId`: a retry with the same id and content
  returns the original `turnId`/`runId`, while a different content for the same id is rejected.
- `session.list` defaults to `includeOneShot=false` and `limit=50` (max 100); results are ordered
  by `updatedAt` descending, then `sessionId` ascending, and paged with an opaque `cursor`.
- `session.subscribe` reuses `event.unsubscribe` and replays session events after `afterSequence`;
  `sessionSequence` is an independent domain from run `sequence`.
- Session events (`session.turn_accepted`, `session.turn_finished`) always carry a `sessionId`;
  run events always carry `sessionId`, `runId`, and a run `sequence`.
- Task planning is run-scoped: `task.created` and `task.updated` carry a `revision` plus a full
  `TaskSnapshot`, and never use a global event scope.
- Only successful, completely paired history enters the next turn context; failed, cancelled, and
  interrupted turns remain auditable but are excluded. Session notes persist, while TaskManager is
  recreated empty for every run.
- A context-budget rejection returns `-32013` before allocating a turn ID, run ID, or run directory.
- Consumers merge session and run journals by identity plus their independent sequence domains;
  timestamps and coincidentally equal text are not deduplication keys.

`agent.run` request (the response identifies the session, run, and initial subscription):

```json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "method": "agent.run",
  "params": {
    "goal": "Summarize the README",
    "workspaceRoot": "/absolute/path/to/workspace"
  }
}
```

## Ping

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "core.ping",
  "params": {
    "clientName": "mc-ping",
    "clientVersion": "0.1.0"
  }
}
```

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "serverVersion": "0.1.0",
    "uptimeMs": 12,
    "receivedAt": "2026-09-12T06:00:00.000Z"
  }
}
```

## Error codes

| Code | Meaning |
| ---: | --- |
| -32700 | Parse error: invalid JSON, invalid UTF-8, or an empty frame |
| -32600 | Invalid request envelope, unsupported notification/batch, or oversized frame |
| -32601 | Method not found |
| -32602 | Invalid `core.ping`, `agent.*`, or `session.*` parameters |
| -32603 | Internal server error |
| -32001 | Requested run was not found |
| -32010 | `session_not_found` |
| -32011 | `session_busy` (another turn already owns the session) |
| -32012 | `session_corrupted` (read-only, diagnostic) |
| -32013 | `context_limit_exceeded` (rejected before any turn/run is created) |
| -32014 | `one_shot_not_resumable` (one-shot sessions cannot accept new messages) |

## JSON Schemas

### JsonRpcRequestEnvelope

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "minLength": 1
    },
    "params": {
      "default": {},
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method"
  ],
  "additionalProperties": false
}
```

### PingParams

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "clientName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "clientVersion": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  },
  "required": [
    "clientName",
    "clientVersion"
  ],
  "additionalProperties": false
}
```

### PingRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "core.ping"
    },
    "params": {
      "type": "object",
      "properties": {
        "clientName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "clientVersion": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "clientName",
        "clientVersion"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### PongResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "serverVersion": {
      "type": "string",
      "minLength": 1
    },
    "uptimeMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "receivedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    }
  },
  "required": [
    "serverVersion",
    "uptimeMs",
    "receivedAt"
  ],
  "additionalProperties": false
}
```

### PingSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "serverVersion": {
          "type": "string",
          "minLength": 1
        },
        "uptimeMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "receivedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        }
      },
      "required": [
        "serverVersion",
        "uptimeMs",
        "receivedAt"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### AgentRunRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "agent.run"
    },
    "params": {
      "type": "object",
      "properties": {
        "goal": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        },
        "workspaceRoot": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "goal",
        "workspaceRoot"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### AgentRunSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "const": "accepted"
        },
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "subscriptionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "status",
        "sessionId",
        "runId",
        "subscriptionId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### AgentCancelRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "agent.cancel"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "sessionId",
        "runId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### AgentCancelSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "outcome": {
          "type": "string",
          "enum": [
            "cancellation_requested",
            "already_finished",
            "not_found"
          ]
        }
      },
      "required": [
        "outcome"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### AgentEvent

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "run.started"
        },
        "payload": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "step.started"
        },
        "payload": {
          "type": "object",
          "properties": {
            "step": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "step"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "llm.model_selected"
        },
        "payload": {
          "type": "object",
          "properties": {
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            }
          },
          "required": [
            "model",
            "provider"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean",
          "const": true
        },
        "type": {
          "type": "string",
          "const": "llm.text_delta"
        },
        "payload": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 16384
            }
          },
          "required": [
            "text"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean",
          "const": true
        },
        "type": {
          "type": "string",
          "const": "llm.retrying"
        },
        "payload": {
          "type": "object",
          "properties": {
            "attempt": {
              "type": "integer",
              "minimum": 2,
              "maximum": 9007199254740991
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 2,
              "maximum": 9007199254740991
            },
            "delayMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "reason": {
              "type": "string",
              "enum": [
                "network",
                "rate_limit",
                "unavailable"
              ]
            }
          },
          "required": [
            "attempt",
            "maxAttempts",
            "delayMs",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "llm.usage"
        },
        "payload": {
          "type": "object",
          "properties": {
            "inputTokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "outputTokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "cacheReadInputTokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "cacheCreationInputTokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "contextWindowTokens": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheCreationInputTokens"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "tool.started"
        },
        "payload": {
          "type": "object",
          "properties": {
            "toolCallId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "attempt": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "toolCallId",
            "name",
            "attempt"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean",
          "const": true
        },
        "type": {
          "type": "string",
          "const": "tool.retrying"
        },
        "payload": {
          "type": "object",
          "properties": {
            "toolCallId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "attempt": {
              "type": "integer",
              "minimum": 2,
              "maximum": 9007199254740991
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 2,
              "maximum": 9007199254740991
            },
            "delayMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "errorCode": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            }
          },
          "required": [
            "toolCallId",
            "name",
            "attempt",
            "maxAttempts",
            "delayMs",
            "errorCode"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "tool.finished"
        },
        "payload": {
          "type": "object",
          "properties": {
            "toolCallId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "isError": {
              "type": "boolean"
            },
            "durationMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "outputBytes": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "truncated": {
              "type": "boolean"
            }
          },
          "required": [
            "toolCallId",
            "name",
            "isError",
            "durationMs",
            "outputBytes",
            "truncated"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "step.finished"
        },
        "payload": {
          "type": "object",
          "properties": {
            "step": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "outcome": {
              "type": "string",
              "enum": [
                "continue",
                "succeeded",
                "failed",
                "cancelled"
              ]
            }
          },
          "required": [
            "step",
            "outcome"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "task.created"
        },
        "payload": {
          "type": "object",
          "properties": {
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "task": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "subject": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 120
                },
                "description": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "in_progress",
                    "completed"
                  ]
                },
                "blocked": {
                  "type": "boolean"
                },
                "blockedBy": {
                  "type": "array",
                  "items": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "createdAt": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "updatedAt": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                }
              },
              "required": [
                "id",
                "subject",
                "description",
                "status",
                "blocked",
                "blockedBy",
                "createdAt",
                "updatedAt"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "revision",
            "task"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "task.updated"
        },
        "payload": {
          "type": "object",
          "properties": {
            "revision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "task": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "subject": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 120
                },
                "description": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "in_progress",
                    "completed"
                  ]
                },
                "blocked": {
                  "type": "boolean"
                },
                "blockedBy": {
                  "type": "array",
                  "items": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "createdAt": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "updatedAt": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                }
              },
              "required": [
                "id",
                "subject",
                "description",
                "status",
                "blocked",
                "blockedBy",
                "createdAt",
                "updatedAt"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "revision",
            "task"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean"
        },
        "type": {
          "type": "string",
          "const": "run.finished"
        },
        "payload": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "finalText": {
                  "type": "string",
                  "maxLength": 262144
                },
                "steps": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "usage": {
                  "type": "object",
                  "properties": {
                    "inputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheReadInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheCreationInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens"
                  ],
                  "additionalProperties": false
                },
                "status": {
                  "type": "string",
                  "const": "succeeded"
                },
                "reason": {
                  "type": "string",
                  "const": "completed"
                }
              },
              "required": [
                "finalText",
                "steps",
                "usage",
                "status",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "finalText": {
                  "type": "string",
                  "maxLength": 262144
                },
                "steps": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "usage": {
                  "type": "object",
                  "properties": {
                    "inputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheReadInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheCreationInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens"
                  ],
                  "additionalProperties": false
                },
                "status": {
                  "type": "string",
                  "const": "cancelled"
                },
                "reason": {
                  "type": "string",
                  "const": "cancelled"
                }
              },
              "required": [
                "finalText",
                "steps",
                "usage",
                "status",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "finalText": {
                  "type": "string",
                  "maxLength": 262144
                },
                "steps": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "usage": {
                  "type": "object",
                  "properties": {
                    "inputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheReadInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheCreationInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens"
                  ],
                  "additionalProperties": false
                },
                "status": {
                  "type": "string",
                  "const": "failed"
                },
                "reason": {
                  "type": "string",
                  "enum": [
                    "config_error",
                    "llm_error",
                    "max_steps",
                    "run_timeout",
                    "invalid_llm_response",
                    "event_store_error",
                    "session_store_error",
                    "internal_error",
                    "core_restarted"
                  ]
                },
                "error": {
                  "type": "object",
                  "properties": {
                    "code": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "message": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1024
                    }
                  },
                  "required": [
                    "code",
                    "message"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "finalText",
                "steps",
                "usage",
                "status",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "sessionId",
        "runId",
        "sequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    }
  ]
}
```

### EventSubscribeRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "event.subscribe"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "afterSequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "sessionId",
        "runId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### EventSubscribeSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "subscriptionId",
        "sessionId",
        "runId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### EventUnsubscribeRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "event.unsubscribe"
    },
    "params": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "subscriptionId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### EventUnsubscribeSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionSummary

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "mode": {
      "type": "string",
      "enum": [
        "chat",
        "one_shot"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "idle",
        "running",
        "corrupted"
      ]
    },
    "title": {
      "type": "string",
      "maxLength": 256
    },
    "workspaceRoot": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "latestSessionSequence": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "activeRun": {
      "type": "object",
      "properties": {
        "turnId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "turnId",
        "runId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "sessionId",
    "mode",
    "status",
    "title",
    "workspaceRoot",
    "createdAt",
    "updatedAt",
    "latestSessionSequence"
  ],
  "additionalProperties": false
}
```

### SessionCreateRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.create"
    },
    "params": {
      "type": "object",
      "properties": {
        "workspaceRoot": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "workspaceRoot"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionCreateSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "session": {
          "type": "object",
          "properties": {
            "sessionId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "mode": {
              "type": "string",
              "enum": [
                "chat",
                "one_shot"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "idle",
                "running",
                "corrupted"
              ]
            },
            "title": {
              "type": "string",
              "maxLength": 256
            },
            "workspaceRoot": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "latestSessionSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "activeRun": {
              "type": "object",
              "properties": {
                "turnId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                }
              },
              "required": [
                "turnId",
                "runId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "sessionId",
            "mode",
            "status",
            "title",
            "workspaceRoot",
            "createdAt",
            "updatedAt",
            "latestSessionSequence"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "session"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionGetRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.get"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionGetSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "session": {
          "type": "object",
          "properties": {
            "sessionId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "mode": {
              "type": "string",
              "enum": [
                "chat",
                "one_shot"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "idle",
                "running",
                "corrupted"
              ]
            },
            "title": {
              "type": "string",
              "maxLength": 256
            },
            "workspaceRoot": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "latestSessionSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "activeRun": {
              "type": "object",
              "properties": {
                "turnId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                }
              },
              "required": [
                "turnId",
                "runId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "sessionId",
            "mode",
            "status",
            "title",
            "workspaceRoot",
            "createdAt",
            "updatedAt",
            "latestSessionSequence"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "session"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionListRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.list"
    },
    "params": {
      "type": "object",
      "properties": {
        "workspaceRoot": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "includeOneShot": {
          "default": false,
          "type": "boolean"
        },
        "cursor": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        "limit": {
          "default": 50,
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionListSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "sessions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sessionId": {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              "mode": {
                "type": "string",
                "enum": [
                  "chat",
                  "one_shot"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "idle",
                  "running",
                  "corrupted"
                ]
              },
              "title": {
                "type": "string",
                "maxLength": 256
              },
              "workspaceRoot": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "createdAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "latestSessionSequence": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "activeRun": {
                "type": "object",
                "properties": {
                  "turnId": {
                    "type": "string",
                    "format": "uuid",
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                  },
                  "runId": {
                    "type": "string",
                    "format": "uuid",
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                  }
                },
                "required": [
                  "turnId",
                  "runId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "sessionId",
              "mode",
              "status",
              "title",
              "workspaceRoot",
              "createdAt",
              "updatedAt",
              "latestSessionSequence"
            ],
            "additionalProperties": false
          }
        },
        "nextCursor": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        }
      },
      "required": [
        "sessions"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionSendMessageRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.sendMessage"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "clientMessageId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        }
      },
      "required": [
        "sessionId",
        "clientMessageId",
        "content"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionSendMessageSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "const": "accepted"
        },
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "turnId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "runId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "status",
        "sessionId",
        "turnId",
        "runId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionGetHistoryRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.getHistory"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionGetHistorySuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "session": {
          "type": "object",
          "properties": {
            "sessionId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "mode": {
              "type": "string",
              "enum": [
                "chat",
                "one_shot"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "idle",
                "running",
                "corrupted"
              ]
            },
            "title": {
              "type": "string",
              "maxLength": 256
            },
            "workspaceRoot": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "createdAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "updatedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "latestSessionSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "activeRun": {
              "type": "object",
              "properties": {
                "turnId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                }
              },
              "required": [
                "turnId",
                "runId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "sessionId",
            "mode",
            "status",
            "title",
            "workspaceRoot",
            "createdAt",
            "updatedAt",
            "latestSessionSequence"
          ],
          "additionalProperties": false
        },
        "turns": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "turnId": {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              "runId": {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              "clientMessageId": {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              "status": {
                "type": "string",
                "enum": [
                  "running",
                  "succeeded",
                  "failed",
                  "cancelled",
                  "interrupted"
                ]
              },
              "reason": {
                "type": "string",
                "enum": [
                  "completed",
                  "cancelled",
                  "core_restarted",
                  "config_error",
                  "llm_error",
                  "max_steps",
                  "run_timeout",
                  "invalid_llm_response",
                  "event_store_error",
                  "session_store_error",
                  "internal_error"
                ]
              },
              "acceptedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "finishedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "includedInContext": {
                "type": "boolean"
              },
              "taskGraph": {
                "type": "object",
                "properties": {
                  "revision": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "tasks": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "subject": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "description": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 4000
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "pending",
                            "in_progress",
                            "completed"
                          ]
                        },
                        "blocked": {
                          "type": "boolean"
                        },
                        "blockedBy": {
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        }
                      },
                      "required": [
                        "id",
                        "subject",
                        "description",
                        "status",
                        "blocked",
                        "blockedBy",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "revision",
                  "tasks"
                ],
                "additionalProperties": false
              },
              "messages": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "messageId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "turnId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "runId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "role": {
                      "type": "string",
                      "enum": [
                        "user",
                        "assistant"
                      ]
                    },
                    "timestamp": {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                    },
                    "content": {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "oneOf": [
                          {
                            "type": "object",
                            "properties": {
                              "type": {
                                "type": "string",
                                "const": "text"
                              },
                              "text": {
                                "type": "string",
                                "maxLength": 262144
                              }
                            },
                            "required": [
                              "type",
                              "text"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "type": {
                                "type": "string",
                                "const": "tool_use"
                              },
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "name": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              },
                              "input": {
                                "type": "object",
                                "propertyNames": {
                                  "type": "string"
                                },
                                "additionalProperties": {}
                              }
                            },
                            "required": [
                              "type",
                              "id",
                              "name",
                              "input"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "type": {
                                "type": "string",
                                "const": "tool_result"
                              },
                              "toolUseId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "content": {
                                "type": "string",
                                "maxLength": 262144
                              },
                              "isError": {
                                "type": "boolean"
                              }
                            },
                            "required": [
                              "type",
                              "toolUseId",
                              "content"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      }
                    }
                  },
                  "required": [
                    "messageId",
                    "turnId",
                    "runId",
                    "role",
                    "timestamp",
                    "content"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "turnId",
              "runId",
              "clientMessageId",
              "status",
              "acceptedAt",
              "includedInContext",
              "messages"
            ],
            "additionalProperties": false
          }
        },
        "throughSessionSequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "session",
        "turns",
        "throughSessionSequence"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionSubscribeRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "method": {
      "type": "string",
      "const": "session.subscribe"
    },
    "params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "afterSequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### SessionSubscribeSuccessResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "result": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "latestSequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "activeRun": {
          "type": "object",
          "properties": {
            "turnId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "runId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            }
          },
          "required": [
            "turnId",
            "runId"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "subscriptionId",
        "sessionId",
        "latestSequence"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "result"
  ],
  "additionalProperties": false
}
```

### SessionEvent

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sessionSequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean",
          "const": true
        },
        "type": {
          "type": "string",
          "const": "session.turn_accepted"
        },
        "payload": {
          "type": "object",
          "properties": {
            "turnId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "runId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "clientMessageId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "userMessage": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32768
            }
          },
          "required": [
            "turnId",
            "runId",
            "clientMessageId",
            "userMessage"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "sessionSequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "sessionSequence": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "durable": {
          "type": "boolean",
          "const": true
        },
        "type": {
          "type": "string",
          "const": "session.turn_finished"
        },
        "payload": {
          "type": "object",
          "properties": {
            "turnId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "runId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "status": {
              "type": "string",
              "enum": [
                "succeeded",
                "failed",
                "cancelled",
                "interrupted"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "completed",
                "cancelled",
                "core_restarted",
                "config_error",
                "llm_error",
                "max_steps",
                "run_timeout",
                "invalid_llm_response",
                "event_store_error",
                "session_store_error",
                "internal_error"
              ]
            }
          },
          "required": [
            "turnId",
            "runId",
            "status"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "sessionId",
        "sessionSequence",
        "timestamp",
        "durable",
        "type",
        "payload"
      ],
      "additionalProperties": false
    }
  ]
}
```

### EventPushNotification

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "method": {
      "type": "string",
      "const": "event.push"
    },
    "params": {
      "type": "object",
      "properties": {
        "subscriptionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        "event": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "run.started"
                },
                "payload": {
                  "type": "object",
                  "properties": {},
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "step.started"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "step"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "llm.model_selected"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "model": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "provider": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 64
                    }
                  },
                  "required": [
                    "model",
                    "provider"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean",
                  "const": true
                },
                "type": {
                  "type": "string",
                  "const": "llm.text_delta"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "text": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 16384
                    }
                  },
                  "required": [
                    "text"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean",
                  "const": true
                },
                "type": {
                  "type": "string",
                  "const": "llm.retrying"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "attempt": {
                      "type": "integer",
                      "minimum": 2,
                      "maximum": 9007199254740991
                    },
                    "maxAttempts": {
                      "type": "integer",
                      "minimum": 2,
                      "maximum": 9007199254740991
                    },
                    "delayMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "reason": {
                      "type": "string",
                      "enum": [
                        "network",
                        "rate_limit",
                        "unavailable"
                      ]
                    }
                  },
                  "required": [
                    "attempt",
                    "maxAttempts",
                    "delayMs",
                    "reason"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "llm.usage"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "inputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheReadInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "cacheCreationInputTokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "contextWindowTokens": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "tool.started"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "toolCallId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "attempt": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "toolCallId",
                    "name",
                    "attempt"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean",
                  "const": true
                },
                "type": {
                  "type": "string",
                  "const": "tool.retrying"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "toolCallId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "attempt": {
                      "type": "integer",
                      "minimum": 2,
                      "maximum": 9007199254740991
                    },
                    "maxAttempts": {
                      "type": "integer",
                      "minimum": 2,
                      "maximum": 9007199254740991
                    },
                    "delayMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "errorCode": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "required": [
                    "toolCallId",
                    "name",
                    "attempt",
                    "maxAttempts",
                    "delayMs",
                    "errorCode"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "tool.finished"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "toolCallId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "isError": {
                      "type": "boolean"
                    },
                    "durationMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outputBytes": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "truncated": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "toolCallId",
                    "name",
                    "isError",
                    "durationMs",
                    "outputBytes",
                    "truncated"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "step.finished"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "step": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "outcome": {
                      "type": "string",
                      "enum": [
                        "continue",
                        "succeeded",
                        "failed",
                        "cancelled"
                      ]
                    }
                  },
                  "required": [
                    "step",
                    "outcome"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "task.created"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "revision": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "task": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "subject": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "description": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 4000
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "pending",
                            "in_progress",
                            "completed"
                          ]
                        },
                        "blocked": {
                          "type": "boolean"
                        },
                        "blockedBy": {
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        }
                      },
                      "required": [
                        "id",
                        "subject",
                        "description",
                        "status",
                        "blocked",
                        "blockedBy",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "revision",
                    "task"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "task.updated"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "revision": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "task": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "subject": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "description": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 4000
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "pending",
                            "in_progress",
                            "completed"
                          ]
                        },
                        "blocked": {
                          "type": "boolean"
                        },
                        "blockedBy": {
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        }
                      },
                      "required": [
                        "id",
                        "subject",
                        "description",
                        "status",
                        "blocked",
                        "blockedBy",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "revision",
                    "task"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean"
                },
                "type": {
                  "type": "string",
                  "const": "run.finished"
                },
                "payload": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "finalText": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "steps": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "usage": {
                          "type": "object",
                          "properties": {
                            "inputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "outputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheReadInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheCreationInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            }
                          },
                          "required": [
                            "inputTokens",
                            "outputTokens",
                            "cacheReadInputTokens",
                            "cacheCreationInputTokens"
                          ],
                          "additionalProperties": false
                        },
                        "status": {
                          "type": "string",
                          "const": "succeeded"
                        },
                        "reason": {
                          "type": "string",
                          "const": "completed"
                        }
                      },
                      "required": [
                        "finalText",
                        "steps",
                        "usage",
                        "status",
                        "reason"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "finalText": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "steps": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "usage": {
                          "type": "object",
                          "properties": {
                            "inputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "outputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheReadInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheCreationInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            }
                          },
                          "required": [
                            "inputTokens",
                            "outputTokens",
                            "cacheReadInputTokens",
                            "cacheCreationInputTokens"
                          ],
                          "additionalProperties": false
                        },
                        "status": {
                          "type": "string",
                          "const": "cancelled"
                        },
                        "reason": {
                          "type": "string",
                          "const": "cancelled"
                        }
                      },
                      "required": [
                        "finalText",
                        "steps",
                        "usage",
                        "status",
                        "reason"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "finalText": {
                          "type": "string",
                          "maxLength": 262144
                        },
                        "steps": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "usage": {
                          "type": "object",
                          "properties": {
                            "inputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "outputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheReadInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "cacheCreationInputTokens": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            }
                          },
                          "required": [
                            "inputTokens",
                            "outputTokens",
                            "cacheReadInputTokens",
                            "cacheCreationInputTokens"
                          ],
                          "additionalProperties": false
                        },
                        "status": {
                          "type": "string",
                          "const": "failed"
                        },
                        "reason": {
                          "type": "string",
                          "enum": [
                            "config_error",
                            "llm_error",
                            "max_steps",
                            "run_timeout",
                            "invalid_llm_response",
                            "event_store_error",
                            "session_store_error",
                            "internal_error",
                            "core_restarted"
                          ]
                        },
                        "error": {
                          "type": "object",
                          "properties": {
                            "code": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 128
                            },
                            "message": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 1024
                            }
                          },
                          "required": [
                            "code",
                            "message"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "finalText",
                        "steps",
                        "usage",
                        "status",
                        "reason"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "required": [
                "sessionId",
                "runId",
                "sequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sessionSequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean",
                  "const": true
                },
                "type": {
                  "type": "string",
                  "const": "session.turn_accepted"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "turnId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "runId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "clientMessageId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "userMessage": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 32768
                    }
                  },
                  "required": [
                    "turnId",
                    "runId",
                    "clientMessageId",
                    "userMessage"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "sessionSequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "sessionId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "sessionSequence": {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                "timestamp": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                },
                "durable": {
                  "type": "boolean",
                  "const": true
                },
                "type": {
                  "type": "string",
                  "const": "session.turn_finished"
                },
                "payload": {
                  "type": "object",
                  "properties": {
                    "turnId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "runId": {
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "status": {
                      "type": "string",
                      "enum": [
                        "succeeded",
                        "failed",
                        "cancelled",
                        "interrupted"
                      ]
                    },
                    "reason": {
                      "type": "string",
                      "enum": [
                        "completed",
                        "cancelled",
                        "core_restarted",
                        "config_error",
                        "llm_error",
                        "max_steps",
                        "run_timeout",
                        "invalid_llm_response",
                        "event_store_error",
                        "session_store_error",
                        "internal_error"
                      ]
                    }
                  },
                  "required": [
                    "turnId",
                    "runId",
                    "status"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "sessionId",
                "sessionSequence",
                "timestamp",
                "durable",
                "type",
                "payload"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "subscriptionId",
        "event"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### JsonRpcNotificationEnvelope

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "method": {
      "type": "string",
      "minLength": 1
    },
    "params": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "jsonrpc",
    "method",
    "params"
  ],
  "additionalProperties": false
}
```

### JsonRpcErrorResponse

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jsonrpc": {
      "type": "string",
      "const": "2.0"
    },
    "id": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "message": {
          "type": "string"
        },
        "data": {}
      },
      "required": [
        "code",
        "message"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "jsonrpc",
    "id",
    "error"
  ],
  "additionalProperties": false
}
```
