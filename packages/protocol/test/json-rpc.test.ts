import { describe, expect, test } from "bun:test";

import {
  JsonRpcErrorCode,
  JsonRpcErrorResponseSchema,
  JsonRpcRequestEnvelopeSchema,
  makeJsonRpcError,
} from "../src/json-rpc.ts";
import { PingRequestSchema, PingSuccessResponseSchema } from "../src/ping.ts";

const validRequest = {
  jsonrpc: "2.0",
  id: "request-1",
  method: "core.ping",
  params: { clientName: "mc-ping", clientVersion: "0.0.1" },
};

describe("JSON-RPC schemas", () => {
  test("accepts string and safe integer IDs", () => {
    expect(JsonRpcRequestEnvelopeSchema.safeParse(validRequest).success).toBe(true);
    expect(JsonRpcRequestEnvelopeSchema.safeParse({ ...validRequest, id: 42 }).success).toBe(true);
  });

  test.each([null, 1.5, Number.MAX_SAFE_INTEGER + 1, ""])("rejects invalid id %p", (id) => {
    expect(JsonRpcRequestEnvelopeSchema.safeParse({ ...validRequest, id }).success).toBe(false);
  });

  test("rejects notifications, batches, wrong versions, and unknown fields", () => {
    const { id: _id, ...notification } = validRequest;
    expect(JsonRpcRequestEnvelopeSchema.safeParse(notification).success).toBe(false);
    expect(JsonRpcRequestEnvelopeSchema.safeParse([validRequest]).success).toBe(false);
    expect(
      JsonRpcRequestEnvelopeSchema.safeParse({ ...validRequest, jsonrpc: "1.0" }).success,
    ).toBe(false);
    expect(
      JsonRpcRequestEnvelopeSchema.safeParse({ ...validRequest, unexpected: true }).success,
    ).toBe(false);
  });

  test("strictly validates ping params and pong results", () => {
    expect(PingRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(
      PingRequestSchema.safeParse({
        ...validRequest,
        params: { ...validRequest.params, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      PingSuccessResponseSchema.safeParse({
        jsonrpc: "2.0",
        id: "request-1",
        result: {
          serverVersion: "0.0.1",
          uptimeMs: 12,
          receivedAt: "2026-09-12T06:00:00.000Z",
        },
      }).success,
    ).toBe(true);
  });

  test("constructs a valid error response without internal data", () => {
    const response = makeJsonRpcError(
      "request-1",
      JsonRpcErrorCode.invalidParams,
      "Invalid params",
    );
    expect(JsonRpcErrorResponseSchema.parse(response)).toEqual(response);
    expect(response.error).toEqual({ code: -32602, message: "Invalid params" });
  });
});
