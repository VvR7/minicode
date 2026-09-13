import { describe, expect, spyOn, test } from "bun:test";

import { main } from "../../src/mc.ts";

describe("mc entry point", () => {
  test("rejects a missing goal with exit code 2", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main([])).resolves.toBe(2);
      expect(String(error.mock.calls[0]?.[0])).toContain("missing required --goal");
    } finally {
      error.mockRestore();
    }
  });

  test("rejects an unknown argument with exit code 2", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main(["--unknown"])).resolves.toBe(2);
    } finally {
      error.mockRestore();
    }
  });
});
