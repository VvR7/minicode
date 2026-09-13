import { describe, expect, spyOn, test } from "bun:test";

import { createLogger } from "../src/logger.ts";

describe("core logger", () => {
  test("filters messages below the configured level", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger("warn");
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/ WARN warn message$/u);
      expect(String(error.mock.calls[1]?.[0])).toMatch(/ ERROR error message$/u);
    } finally {
      error.mockRestore();
    }
  });
});
