import { describe, expect, test } from "bun:test";

import * as core from "../src/index.ts";

describe("core public exports", () => {
  test("exports the supported composition and transport APIs", () => {
    expect(core.CoreApp).toBeDefined();
    expect(core.createRpcDispatcher).toBeDefined();
    expect(core.NdjsonRpcServer).toBeDefined();
    expect(core.RUNTIME_CONFIG.agent.maxSteps).toBe(200);
  });
});
