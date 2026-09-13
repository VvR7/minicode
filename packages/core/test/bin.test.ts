import { describe, expect, spyOn, test } from "bun:test";

import { main } from "../src/bin.ts";

describe("mc-core entrypoint", () => {
  test("rejects command-line arguments", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main(["unexpected"])).resolves.toBe(2);
      expect(error).toHaveBeenCalledWith("error: mc-core does not accept arguments");
    } finally {
      error.mockRestore();
    }
  });
});
