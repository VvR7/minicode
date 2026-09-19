import { describe, expect, test } from "bun:test";

import { ConfigurationError } from "@minicode/protocol";

import { loadCoreConfig } from "../src/config.ts";

describe("core configuration", () => {
  test("uses default log level", () => {
    const config = loadCoreConfig({});
    expect(config.logLevel).toBe("info");
    expect(config.permissionMode).toBe("bypasspermission");
    expect(config.homeDirectory.endsWith("/.minicode")).toBe(true);
  });

  test("normalizes configured log level", () => {
    expect(loadCoreConfig({ MINICODE_LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
  });

  test("rejects an invalid log level", () => {
    expect(() => loadCoreConfig({ MINICODE_LOG_LEVEL: "verbose" })).toThrow(ConfigurationError);
  });

  test("normalizes and validates the permission mode", () => {
    expect(loadCoreConfig({ MINICODE_PERMISSION_MODE: "ALWAYSASK" }).permissionMode).toBe(
      "alwaysask",
    );
    expect(() => loadCoreConfig({ MINICODE_PERMISSION_MODE: "allow" })).toThrow(ConfigurationError);
  });

  test("accepts only an absolute MINICODE_HOME", () => {
    expect(loadCoreConfig({ MINICODE_HOME: "/var/tmp/minicode" }).homeDirectory).toBe(
      "/var/tmp/minicode",
    );
    expect(() => loadCoreConfig({ MINICODE_HOME: "relative/path" })).toThrow(ConfigurationError);
  });
});
