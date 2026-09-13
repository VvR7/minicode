import { describe, expect, test } from "bun:test";

import { JsonRpcErrorCode } from "@minicode/protocol";

import { PingHandler } from "../src/handlers/ping-handler.ts";
import { RpcMethodHandler } from "../src/handlers/rpc-method-handler.ts";
import type { RpcInvocationContext } from "../src/rpc-context.ts";
import { createRpcDispatcher } from "../src/rpc-dispatcher.ts";

function createContext(): RpcInvocationContext {
  return {
    connection: {
      id: "test-connection",
      closed: new Promise<void>(() => {}),
      sendNotification: async () => true,
      disconnect: () => {},
    },
  };
}

function createPingDispatcher() {
  return createRpcDispatcher({
    handlers: [
      new PingHandler({
        uptimeMs: () => 12.9,
        now: () => new Date("2026-09-12T06:00:00.000Z"),
      }),
    ],
  });
}

class TestHandler extends RpcMethodHandler {
  readonly method = "test.echo";
  receivedParams: unknown;

  async invoke(params: unknown) {
    this.receivedParams = params;
    return { kind: "success" as const, result: { echoed: params } };
  }
}

class ThrowingHandler extends RpcMethodHandler {
  readonly method = "test.fail";

  async invoke(_params: unknown): Promise<never> {
    throw new Error("private implementation details");
  }
}

describe("RPC dispatcher", () => {
  test("returns a typed pong", async () => {
    const dispatch = createPingDispatcher();
    await expect(
      dispatch(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "core.ping",
          params: { clientName: "test", clientVersion: "0.0.1" },
        },
        createContext(),
      ),
    ).resolves.toEqual({
      response: {
        jsonrpc: "2.0",
        id: 7,
        result: {
          serverVersion: "0.1.0",
          uptimeMs: 12,
          receivedAt: "2026-09-12T06:00:00.000Z",
        },
      },
    });
  });

  test("distinguishes invalid request, unknown method, and invalid params", async () => {
    const dispatch = createPingDispatcher();
    const context = createContext();
    const invalidRequest = (await dispatch({ jsonrpc: "2.0", method: "core.ping" }, context))
      .response;
    const unknownMethod = await dispatch(
      {
        jsonrpc: "2.0",
        id: "unknown",
        method: "core.unknown",
        params: {},
      },
      context,
    ).then((result) => result.response);
    const invalidParams = await dispatch(
      {
        jsonrpc: "2.0",
        id: "params",
        method: "core.ping",
        params: {},
      },
      context,
    ).then((result) => result.response);

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

  test("routes a registered method to its own handler", async () => {
    const handler = new TestHandler();
    const dispatch = createRpcDispatcher({ handlers: [handler] });

    await expect(
      dispatch(
        {
          jsonrpc: "2.0",
          id: "echo",
          method: "test.echo",
          params: { value: "hello" },
        },
        createContext(),
      ),
    ).resolves.toEqual({
      response: {
        jsonrpc: "2.0",
        id: "echo",
        result: { echoed: { value: "hello" } },
      },
    });
    expect(handler.receivedParams).toEqual({ value: "hello" });
  });

  test("rejects duplicate handler registrations", () => {
    expect(() => createRpcDispatcher({ handlers: [new TestHandler(), new TestHandler()] })).toThrow(
      "duplicate RPC handler registration: test.echo",
    );
  });

  test("maps a handler exception to a safe internal error", async () => {
    const dispatch = createRpcDispatcher({ handlers: [new ThrowingHandler()] });

    await expect(
      dispatch({ jsonrpc: "2.0", id: "failure", method: "test.fail", params: {} }, createContext()),
    ).resolves.toEqual({
      response: {
        jsonrpc: "2.0",
        id: "failure",
        error: { code: JsonRpcErrorCode.internalError, message: "Internal error" },
      },
    });
  });
});
