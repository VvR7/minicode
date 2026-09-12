import { describe, expect, test } from "bun:test";

import { JsonRpcErrorCode } from "@minicode/protocol";

import { createRpcDispatcher } from "../src/rpc-dispatcher.ts";

const dispatch = createRpcDispatcher({
  uptimeMs: () => 12.9,
  now: () => new Date("2026-09-12T06:00:00.000Z"),
});

describe("RPC dispatcher", () => {
  test("returns a typed pong", async () => {
    await expect(
      dispatch({
        jsonrpc: "2.0",
        id: 7,
        method: "core.ping",
        params: { clientName: "test", clientVersion: "0.0.1" },
      }),
    ).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        serverVersion: "0.0.1",
        uptimeMs: 12,
        receivedAt: "2026-09-12T06:00:00.000Z",
      },
    });
  });

  test("distinguishes invalid request, unknown method, and invalid params", async () => {
    const invalidRequest = await dispatch({ jsonrpc: "2.0", method: "core.ping" });
    const unknownMethod = await dispatch({
      jsonrpc: "2.0",
      id: "unknown",
      method: "core.unknown",
      params: {},
    });
    const invalidParams = await dispatch({
      jsonrpc: "2.0",
      id: "params",
      method: "core.ping",
      params: {},
    });

    expect("error" in invalidRequest && invalidRequest.error.code).toBe(
      JsonRpcErrorCode.invalidRequest,
    );
    expect("error" in unknownMethod && unknownMethod.error.code).toBe(
      JsonRpcErrorCode.methodNotFound,
    );
    expect("error" in invalidParams && invalidParams.error.code).toBe(
      JsonRpcErrorCode.invalidParams,
    );
  });
});
