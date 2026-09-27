import { describe, expect, test } from "bun:test";
import { parseOptions } from "./cli.ts";

describe("SWE-bench CLI", () => {
  test("uses the agreed independent timeout defaults", () => {
    const options = parseOptions([], "/repo");
    expect(options.agentTimeoutMs).toBe(30 * 60 * 1000);
    expect(options.pullTimeoutMs).toBe(30 * 60 * 1000);
    expect(options.startupTimeoutMs).toBe(2 * 60 * 1000);
    expect(options.evaluationTimeoutMs).toBe(30 * 60 * 1000);
  });

  test("parses task selection, resume and configurable timeouts", () => {
    const options = parseOptions(
      [
        "--task",
        "django__django-11790",
        "--limit",
        "1",
        "--resume",
        "--agent-timeout-minutes",
        "45",
        "--startup-timeout-seconds",
        "90",
      ],
      "/repo",
    );
    expect(options.taskId).toBe("django__django-11790");
    expect(options.limit).toBe(1);
    expect(options.resume).toBe(true);
    expect(options.agentTimeoutMs).toBe(45 * 60 * 1000);
    expect(options.startupTimeoutMs).toBe(90 * 1000);
  });

  test("rejects unknown flags and ambiguous task limits", () => {
    expect(() => parseOptions(["--wat"], "/repo")).toThrow();
    expect(() =>
      parseOptions(["--task", "django__django-11790", "--limit", "2"], "/repo"),
    ).toThrow();
  });
});
