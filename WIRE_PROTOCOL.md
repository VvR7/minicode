# Wire Protocol

> Generated from Zod schemas by `packages/protocol/scripts/generate-wire-protocol.ts`.
> Do not edit manually; run `bun run protocol:docs`.

## Transport

- TCP loopback only: `127.0.0.1:7437` by default, configurable with
  `MINICODE_CORE_HOST` / `MINICODE_CORE_PORT`.
- UTF-8 NDJSON: one non-empty JSON value per LF-terminated frame; CRLF is accepted.
- Maximum payload is 1 MiB per frame, excluding the newline delimiter.
- A Core connection accepts multiple requests serially. `mc-ping` sends one request and closes.

## JSON-RPC profile

- JSON-RPC version `2.0` with one request object and one response object per frame.
- Request IDs are non-empty strings or safe integers and are echoed unchanged.
- Notifications and batch arrays are not supported and return `-32600`.
- Objects are strict: unknown fields are rejected.

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
