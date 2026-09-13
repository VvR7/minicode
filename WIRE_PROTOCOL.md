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
- Server-to-client `event.push` notifications have no request ID and carry one typed agent event.
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

## Ping

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "core.ping",
  "params": {
    "clientName": "mc-ping",
    "clientVersion": "0.0.1"
  }
}
```

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "serverVersion": "0.0.1",
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
| -32602 | Invalid `core.ping` parameters |
| -32603 | Internal server error |
| -32001 | Requested run was not found |

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
                  "type": "boolean"
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
                  "type": "boolean"
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
                  "type": "boolean"
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
