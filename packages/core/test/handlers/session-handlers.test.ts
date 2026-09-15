import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode } from "@minicode/protocol";
import { sessionFailureInvocation } from "../../src/handlers/session-handlers.ts";

describe("session RPC error mapping", () => {
  test("maps every stable session failure to its wire code and safe identity data", () => {
    const cases = [
      ["session_not_found", JsonRpcErrorCode.sessionNotFound],
      ["session_busy", JsonRpcErrorCode.sessionBusy],
      ["session_corrupted", JsonRpcErrorCode.sessionCorrupted],
      ["context_limit_exceeded", JsonRpcErrorCode.contextLimitExceeded],
      ["one_shot_not_resumable", JsonRpcErrorCode.oneShotNotResumable],
      ["internal_error", JsonRpcErrorCode.internalError],
    ] as const;

    for (const [code, wireCode] of cases) {
      expect(
        sessionFailureInvocation({
          code,
          message: "safe message",
          sessionId: "550e8400-e29b-41d4-a716-446655440020",
          runId: "6ba7b810-9dad-41d1-80b4-00c04fd43020",
        }),
      ).toEqual({
        kind: "error",
        code: wireCode,
        message: "safe message",
        data: {
          sessionId: "550e8400-e29b-41d4-a716-446655440020",
          runId: "6ba7b810-9dad-41d1-80b4-00c04fd43020",
        },
      });
    }
  });

  test("keeps invalid params on the standard JSON-RPC path", () => {
    expect(sessionFailureInvocation({ code: "invalid_params", message: "invalid" })).toEqual({
      kind: "invalid-params",
    });
  });
});
