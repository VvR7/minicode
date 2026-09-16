import { expect, test } from "bun:test";
import {
  permissionRequest,
  permissionResolved,
  runFinished,
} from "../../client/test/helpers/permission-fixture.ts";
import { TuiModel } from "../src/model.ts";
import { allowedChoices, formatPermissionBlock } from "../src/widgets/permission-block.ts";

/** 构造已连接且有一个未决审批的模型。 */
function pending() {
  const model = new TuiModel();
  model.apply({ type: "controller.status", status: "connected" });
  model.apply({ type: "run.event", event: permissionRequest });
  return model;
}

test("replay updates one inline block only on authoritative resolution", () => {
  const model = pending();
  model.apply({ type: "run.event", event: permissionRequest });
  expect(model.snapshot().lines).toHaveLength(1);
  expect(model.beginPermission("always_allow")).toBeDefined();
  expect(model.beginPermission("deny_once")).toBeUndefined();
  model.finishPermission(permissionRequest.payload.permissionRequestId, "accepted");
  expect(model.snapshot().permission?.status).toBe("pending");
  expect(model.snapshot().lines[0]?.text).toContain("awaiting Core");
  model.apply({ type: "run.event", event: permissionResolved(permissionRequest, "deny_once") });
  expect(model.snapshot().permission).toBeUndefined();
  expect(model.snapshot().lines).toHaveLength(1);
  expect(model.snapshot().lines[0]?.text).toContain("Deny once");
});

test("selection skips non-cacheable choices and bounded summary escapes controls", () => {
  const request = {
    ...permissionRequest,
    payload: { ...permissionRequest.payload, cacheable: false },
  };
  const model = new TuiModel();
  model.syncPermissions([{ request, status: "pending" }]);
  model.movePermission(1);
  expect(model.snapshot().permissionSelection).toBe("deny_once");
  model.movePermission(-1);
  expect(model.snapshot().permissionSelection).toBe("allow_once");
  expect(allowedChoices({ request, status: "pending" })).toEqual(["allow_once", "deny_once"]);
  const text = formatPermissionBlock(
    {
      request: {
        ...request,
        payload: {
          ...request.payload,
          summary: { kind: "bash", command: "echo \u001b[31m", timeoutSeconds: 120 },
        },
      },
      status: "pending",
    },
    "allow_once",
  );
  expect(text).toContain("disabled");
  expect(text).not.toContain("\u001b");
});

test("reconnect releases sending lock while error and expired outcomes remain coherent", () => {
  const model = pending();
  const id = permissionRequest.payload.permissionRequestId;
  model.beginPermission("allow_once");
  model.apply({ type: "controller.status", status: "reconnecting" });
  expect(model.beginPermission("allow_once")).toBeUndefined();
  model.apply({ type: "controller.status", status: "connected" });
  model.syncPermissions([{ request: permissionRequest, status: "pending" }]);
  expect(model.beginPermission("deny_once")).toBeDefined();
  model.finishPermission(id, undefined, "network unavailable");
  expect(model.snapshot().lines[0]?.text).toContain("network unavailable");
  expect(model.beginPermission("deny_once")).toBeDefined();
  model.finishPermission(id, "already_resolved");
  expect(model.snapshot().permission).toBeUndefined();
  model.apply({ type: "run.event", event: permissionResolved() });
  expect(model.snapshot().lines[0]?.text).toContain("Allow once");
  const expired = pending();
  expired.finishPermission(id, "not_found");
  expect(expired.snapshot().permission).toBeUndefined();
});

test("cancellation blocks response and terminal state closes pending without a fake deny", () => {
  const model = pending();
  model.apply({
    type: "run.event",
    event: { ...permissionRequest, sequence: 2, type: "run.started", payload: {} },
  });
  model.markCancelling();
  expect(model.beginPermission("allow_once")).toBeUndefined();
  model.apply({ type: "run.event", event: runFinished(permissionRequest, 3) });
  expect(model.snapshot().permission).toBeUndefined();
  expect(model.snapshot().lines[0]?.text).toContain("closed");
  model.reset();
  expect(model.snapshot().lines).toHaveLength(0);
});
