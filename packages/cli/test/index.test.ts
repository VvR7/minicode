import { describe, expect, test } from "bun:test";

import * as cli from "../src/index.ts";

describe("CLI public exports", () => {
  test("exports command APIs", () => {
    expect(cli.runPingCommand).toBeDefined();
    expect(cli.runGoalCommand).toBeDefined();
    expect(cli.parseGoalArgs).toBeDefined();
  });
});
