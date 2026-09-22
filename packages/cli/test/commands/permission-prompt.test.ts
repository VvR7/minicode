import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { PermissionDecision } from "@minicode/protocol";
import { permissionRequest } from "../../../client/test/helpers/permission-fixture.ts";
import { ApprovalQueue, promptPermission } from "../../src/commands/permission-prompt.ts";

describe("terminal permission prompt", () => {
  for (const [choice, decision] of [
    ["1", "allow_once"],
    ["2", "always_allow"],
    ["3", "deny_once"],
    ["4", "always_deny"],
  ] as const) {
    test(`supports ${decision}`, async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let ui = "";
      output.on("data", (chunk) => {
        ui += chunk.toString();
      });
      const waiting = promptPermission(
        permissionRequest,
        new AbortController().signal,
        input,
        output,
      );
      input.write("invalid\n");
      input.write(`${choice}\n`);
      expect(await waiting).toBe(decision);
      expect(ui).toContain("file.txt");
      expect(ui).toContain("Choose 1, 2, 3 or 4");
      input.destroy();
      output.destroy();
    });
  }

  test("disables always for composite requests and safely escapes preview control characters", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let ui = "";
    output.on("data", (chunk) => {
      ui += chunk.toString();
    });
    const request = {
      ...permissionRequest,
      payload: {
        ...permissionRequest.payload,
        cacheable: false,
        summary: {
          ...permissionRequest.payload.summary,
          kind: "bash" as const,
          command: "echo \u001b[2J",
          timeoutSeconds: 120,
        },
      },
    };
    const waiting = promptPermission(request, new AbortController().signal, input, output);
    input.write("2\n4\n1\n");
    expect(await waiting).toBe("allow_once");
    expect(ui).toContain("always unavailable");
    expect(ui).not.toContain("\u001b");
    input.destroy();
    output.destroy();
  });

  test("EOF and abort release the input without hanging", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const aborted = promptPermission(permissionRequest, controller.signal, input, output);
    controller.abort();
    expect(await aborted).toBe("deny_once");
    expect(await promptPermission(permissionRequest, controller.signal, input, output)).toBe(
      "deny_once",
    );
    const eof = promptPermission(permissionRequest, new AbortController().signal, input, output);
    input.end();
    expect(await eof).toBe("deny_once");
    output.destroy();
  });
});

describe("ApprovalQueue", () => {
  test("reports a failed send, then permits a fresh prompt after reconnect", async () => {
    const errors: string[] = [];
    let prompts = 0;
    let sends = 0;
    const queue = new ApprovalQueue({
      prompt: async () => {
        prompts++;
        return "allow_once";
      },
      respond: async () => {
        sends++;
        if (sends === 1) throw new Error("send failed");
        return { outcome: "accepted" };
      },
      write: (text) => errors.push(text),
    });
    const pending = [{ request: permissionRequest, status: "pending" as const }];
    queue.setConnected(true);
    queue.update(pending);
    await Bun.sleep(0);
    expect(errors[0]).toContain("permission response failed");
    queue.update(pending);
    expect(prompts).toBe(1);
    queue.setConnected(false);
    queue.setConnected(true);
    queue.update(pending);
    await Bun.sleep(0);
    expect(prompts).toBe(2);
    expect(sends).toBe(2);
    queue.close();
  });

  test("unavailable input denies once without optimistic resolution", async () => {
    let decision: PermissionDecision | undefined;
    let prompts = 0;
    const queue = new ApprovalQueue({
      prompt: async () => {
        prompts++;
        throw new Error("input unavailable");
      },
      respond: async (_request, answer) => {
        decision = answer;
        return { outcome: "accepted" };
      },
      write: () => {},
    });
    queue.setConnected(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    await Bun.sleep(0);
    expect(decision).toBe("deny_once");
    queue.update([{ request: permissionRequest, status: "pending" }]);
    expect(prompts).toBe(1);
    queue.close();
  });

  test("deduplicates snapshots and stops an obsolete prompt without sending", async () => {
    const prompts: AbortSignal[] = [];
    const decision = Promise.withResolvers<PermissionDecision>();
    let sends = 0;
    const queue = new ApprovalQueue({
      prompt: async (_request, signal) => {
        prompts.push(signal);
        return decision.promise;
      },
      respond: async () => {
        sends++;
        return { outcome: "accepted" };
      },
      write: () => {},
    });
    queue.setConnected(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    expect(prompts).toHaveLength(1);
    queue.update([{ request: permissionRequest, status: "closed" }]);
    expect(prompts[0]?.aborted).toBe(true);
    decision.resolve("always_allow");
    await Bun.sleep(0);
    expect(sends).toBe(0);
    queue.close();
  });

  test("reconnect re-prompts pending approval; cancellation abandons late input", async () => {
    const prompts: AbortSignal[] = [];
    const queue = new ApprovalQueue({
      prompt: async (_request, signal) => {
        prompts.push(signal);
        return new Promise(() => {});
      },
      respond: async () => ({ outcome: "accepted" }),
      write: () => {},
    });
    queue.setConnected(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    queue.setConnected(false);
    expect(prompts[0]?.aborted).toBe(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    expect(prompts).toHaveLength(1);
    queue.setConnected(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    expect(prompts).toHaveLength(2);
    queue.close();
    expect(prompts[1]?.aborted).toBe(true);
    queue.update([{ request: permissionRequest, status: "pending" }]);
    expect(prompts).toHaveLength(2);
  });
});

test("MCP terminal approval displays full tool scope and redacted summary", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let ui = "";
  output.on("data", (chunk) => {
    ui += chunk.toString();
  });
  const request = {
    ...permissionRequest,
    payload: {
      ...permissionRequest.payload,
      name: "mcp__demo__search",
      riskCategories: ["mcp" as const],
      summary: {
        kind: "mcp" as const,
        server: "demo",
        tool: "search",
        paramsPreview: '{"token":"[REDACTED]"}',
      },
    },
  };
  const pending = promptPermission(request, new AbortController().signal, input, output);
  input.write("2\n");
  expect(await pending).toBe("always_allow");
  expect(ui).toContain("approval scope: mcp__demo__search");
  expect(ui).toContain("[REDACTED]");
  input.destroy();
  output.destroy();
});
