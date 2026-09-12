import { describe, expect, test } from "bun:test";

import { ConfigurationError } from "@minicode/protocol";

import { loadCoreConfig } from "../src/config.ts";

describe("core configuration", () => {
  test("uses default log level", () => {
    expect(loadCoreConfig({}).logLevel).toBe("info");
  });

  test("normalizes configured log level", () => {
    expect(loadCoreConfig({ MINICODE_LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
  });

  test("rejects an invalid log level", () => {
    expect(() => loadCoreConfig({ MINICODE_LOG_LEVEL: "verbose" })).toThrow(ConfigurationError);
  });
});
