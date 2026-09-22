import { expect, test } from "bun:test";
import { DEFAULT_MAX_STEPS } from "../src/agent/context.ts";
import { MAX_SUBAGENT_PARALLEL_TOOL_RESULT_BYTES } from "../src/agent/loop.ts";
import { RUNTIME_CONFIG } from "../src/runtime-config.ts";
import {
  DEFAULT_TOOL_MAX_ATTEMPTS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_BYTES,
} from "../src/tools/types.ts";

test("runtime config is the source of agent and tool compatibility defaults", () => {
  expect(RUNTIME_CONFIG.agent.maxSteps).toBe(200);
  expect(RUNTIME_CONFIG.subagent.maxSteps).toBe(50);
  expect(RUNTIME_CONFIG.subagent.maxConfiguredSteps).toBe(50);
  expect(DEFAULT_MAX_STEPS).toBe(RUNTIME_CONFIG.agent.maxSteps);
  expect(MAX_SUBAGENT_PARALLEL_TOOL_RESULT_BYTES).toBe(
    RUNTIME_CONFIG.subagent.parallelToolResultMaxBytes,
  );
  expect(MAX_TOOL_RESULT_BYTES).toBe(RUNTIME_CONFIG.tool.resultMaxBytes);
  expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(RUNTIME_CONFIG.tool.timeoutMs);
  expect(DEFAULT_TOOL_MAX_ATTEMPTS).toBe(RUNTIME_CONFIG.tool.maxAttempts);
  expect(RUNTIME_CONFIG.context.compactionReserveTokens).toBe(16_384);
  expect(RUNTIME_CONFIG.context.compactionSummaryAttempts).toBe(2);
  expect(RUNTIME_CONFIG.context.compactionProviderMaxAttempts).toBe(1);
  expect(RUNTIME_CONFIG.mcp.requestTimeoutMs).toBe(10_000);
});
