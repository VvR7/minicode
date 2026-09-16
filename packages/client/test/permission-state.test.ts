import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@minicode/protocol";
import { PermissionState } from "../src/permission-state.ts";
import { permissionRequest, runFinished } from "./helpers/permission-fixture.ts";

describe("PermissionState", () => {
  test("deduplicates replay and preserves the journal decision", () => {
    const state = new PermissionState();
    expect(state.apply(permissionRequest)).toBe(true);
    expect(state.apply(permissionRequest)).toBe(false);
    expect(state.snapshot[0]?.status).toBe("pending");
    expect(state.close(permissionRequest.payload.permissionRequestId)).toBe(true);
    const resolution: AgentEvent = {
      ...permissionRequest,
      sequence: 2,
      type: "permission.resolved",
      payload: {
        permissionRequestId: permissionRequest.payload.permissionRequestId,
        toolCallId: "write-1",
        name: "write",
        decision: "always_deny",
        allowed: false,
        source: "user",
      },
    };
    expect(state.apply(resolution)).toBe(true);
    expect(state.apply(resolution)).toBe(false);
    expect(state.apply({ ...permissionRequest, sequence: 3 })).toBe(false);
    expect(state.snapshot).toEqual([
      { request: permissionRequest, status: "resolved", resolution },
    ]);
    expect(state.close()).toBe(false);
    state.clear();
    expect(state.snapshot).toEqual([]);
    expect(state.apply(permissionRequest)).toBe(true);
  });

  test("tool terminal only closes its own pending request; run terminal closes the rest", () => {
    const state = new PermissionState();
    state.apply(permissionRequest);
    state.apply({
      ...permissionRequest,
      sequence: 2,
      payload: {
        ...permissionRequest.payload,
        toolCallId: "write-2",
        permissionRequestId: crypto.randomUUID(),
      },
    });
    const terminal = {
      ...permissionRequest,
      sequence: 3,
      type: "tool.finished",
      payload: { toolCallId: "write-1" },
    } as AgentEvent;
    expect(state.apply(terminal)).toBe(true);
    expect(state.snapshot.map((entry) => entry.status)).toEqual(["closed", "pending"]);
    expect(state.apply({ ...terminal, sequence: 4 })).toBe(false);
    expect(state.apply(runFinished(permissionRequest, 5))).toBe(true);
    expect(state.snapshot.map((entry) => entry.status)).toEqual(["closed", "closed"]);
    expect(state.snapshot.every((entry) => entry.resolution === undefined)).toBe(true);
  });
});
