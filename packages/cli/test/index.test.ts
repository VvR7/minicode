import { describe, expect, test } from "bun:test";

import * as cli from "../src/index.ts";

describe("CLI public exports", () => {
  test("exports command and transport APIs", () => {
    expect(cli.runPingCommand).toBeDefined();
    expect(cli.NdjsonRpcClient).toBeDefined();
    expect(cli.RpcClientError).toBeDefined();
  });
});
