import { describe, expect, test } from "bun:test";

import {
  ConfigurationError,
  DEFAULT_CORE_HOST,
  DEFAULT_CORE_PORT,
  formatEndpoint,
  parseCoreEndpoint,
} from "../src/config.ts";

describe("core endpoint configuration", () => {
  test("uses loopback defaults", () => {
    expect(parseCoreEndpoint({})).toEqual({
      host: DEFAULT_CORE_HOST,
      port: DEFAULT_CORE_PORT,
    });
  });

  test("accepts IPv4 and IPv6 loopback overrides", () => {
    expect(
      parseCoreEndpoint({ MINICODE_CORE_HOST: "127.0.0.1", MINICODE_CORE_PORT: "9000" }),
    ).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(parseCoreEndpoint({ MINICODE_CORE_HOST: "::1", MINICODE_CORE_PORT: "9001" })).toEqual({
      host: "::1",
      port: 9001,
    });
    expect(formatEndpoint({ host: "::1", port: 9001 })).toBe("[::1]:9001");
  });

  test.each(["0", "65536", "7.5", "", "abc"])("rejects invalid port %s", (port) => {
    expect(() => parseCoreEndpoint({ MINICODE_CORE_PORT: port })).toThrow(ConfigurationError);
  });

  test("rejects non-loopback hosts", () => {
    expect(() => parseCoreEndpoint({ MINICODE_CORE_HOST: "0.0.0.0" })).toThrow(ConfigurationError);
  });
});
