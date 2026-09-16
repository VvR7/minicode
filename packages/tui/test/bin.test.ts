import { describe, expect, test } from "bun:test";

import { initialContextWindow, main } from "../src/bin.ts";

const env = {
  MINICODE_CORE_HOST: "127.0.0.1",
  MINICODE_CORE_PORT: "7437",
};

describe("mc-tui entry point", () => {
  test("uses a backwards-compatible context default and accepts an explicit window", () => {
    expect(initialContextWindow({})).toBe(200_000);
    expect(initialContextWindow({ LLM_CONTEXT_WINDOW_TOKENS: "128000" })).toBe(128_000);
    expect(initialContextWindow({ LLM_CONTEXT_WINDOW_TOKENS: "invalid" })).toBeUndefined();
  });

  test("accepts no launch arguments but still rejects non-TTY", async () => {
    expect(await main([], env, false)).toBe(2);
  });

  test("rejects an unknown argument with exit code 2", async () => {
    expect(await main(["--unknown"], env, true)).toBe(2);
  });

  test("rejects non-TTY environments before starting the renderer", async () => {
    expect(await main(["--goal", "summarize"], env, false)).toBe(2);
  });

  test("rejects an invalid endpoint configuration with exit code 2", async () => {
    const badEnv = { MINICODE_CORE_HOST: "0.0.0.0", MINICODE_CORE_PORT: "7437" };
    expect(await main(["--goal", "summarize"], badEnv, true)).toBe(2);
  });
});
