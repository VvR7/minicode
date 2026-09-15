import { describe, expect, test } from "bun:test";
import type { Environment } from "@minicode/protocol";
import { loadTraceConfig } from "../../src/trace/config.ts";
import {
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_SHUTDOWN_MS_DEFAULT,
} from "../../src/trace/types.ts";

function env(overrides: Record<string, string | undefined>): Environment {
  return { ...overrides };
}

describe("loadTraceConfig", () => {
  test("applies documented defaults when enabled", () => {
    const result = loadTraceConfig(env({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        enabled: true,
        payload: "summary",
        queueEvents: TRACE_QUEUE_EVENTS_DEFAULT,
        maxBytes: TRACE_MAX_BYTES_DEFAULT,
        shutdownMs: TRACE_SHUTDOWN_MS_DEFAULT,
      });
    }
  });

  test("returns a disabled config when enabled=false without validating the rest", () => {
    const result = loadTraceConfig(
      env({ MINICODE_TRACE_ENABLED: "false", MINICODE_TRACE_QUEUE_EVENTS: "garbage" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(false);
    }
  });

  test("rejects an invalid enabled flag", () => {
    expect(loadTraceConfig(env({ MINICODE_TRACE_ENABLED: "yes" })).ok).toBe(false);
  });

  test("accepts summary and full, rejects other payload modes", () => {
    expect(loadTraceConfig(env({ MINICODE_TRACE_PAYLOAD: "summary" })).ok).toBe(true);
    expect(loadTraceConfig(env({ MINICODE_TRACE_PAYLOAD: "full" })).ok).toBe(true);
    expect(loadTraceConfig(env({ MINICODE_TRACE_PAYLOAD: "none" })).ok).toBe(false);
  });

  test("validates queue events bounds", () => {
    for (const value of ["16", "65536", "1024"]) {
      expect(loadTraceConfig(env({ MINICODE_TRACE_QUEUE_EVENTS: value })).ok).toBe(true);
    }
    for (const value of ["15", "65537", "0", "abc"]) {
      expect(loadTraceConfig(env({ MINICODE_TRACE_QUEUE_EVENTS: value })).ok).toBe(false);
    }
  });

  test("validates max bytes lower bound", () => {
    expect(loadTraceConfig(env({ MINICODE_TRACE_MAX_BYTES: "1048576" })).ok).toBe(true);
    expect(loadTraceConfig(env({ MINICODE_TRACE_MAX_BYTES: "33554432" })).ok).toBe(true);
    for (const value of ["1048575", "0", "abc"]) {
      expect(loadTraceConfig(env({ MINICODE_TRACE_MAX_BYTES: value })).ok).toBe(false);
    }
  });

  test("validates shutdown ms bounds", () => {
    for (const value of ["100", "30000", "2000"]) {
      expect(loadTraceConfig(env({ MINICODE_TRACE_SHUTDOWN_MS: value })).ok).toBe(true);
    }
    for (const value of ["99", "30001", "abc"]) {
      expect(loadTraceConfig(env({ MINICODE_TRACE_SHUTDOWN_MS: value })).ok).toBe(false);
    }
  });
});
