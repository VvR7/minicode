import { describe, expect, test } from "bun:test";
import { loadCompactionConfig } from "../../src/session/compaction-config.ts";
const budget = { contextWindowTokens: 200000, maxOutputTokens: 8192 };
describe("compaction config", () => {
  test("defaults and explicit settings", () => {
    expect(loadCompactionConfig({}, budget)).toEqual({
      ok: true,
      value: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    });
    expect(
      loadCompactionConfig(
        {
          MINICODE_COMPACTION_ENABLED: "false",
          MINICODE_COMPACTION_RESERVE_TOKENS: "9000",
          MINICODE_COMPACTION_KEEP_RECENT_TOKENS: "1000",
        },
        budget,
      ),
    ).toEqual({ ok: true, value: { enabled: false, reserveTokens: 9000, keepRecentTokens: 1000 } });
  });
  test("rejects invalid values and incompatible windows even when auto disabled", () => {
    for (const raw of ["", "-1", "0", "1.5", "1e4", "9007199254740992"]) {
      expect(loadCompactionConfig({ MINICODE_COMPACTION_RESERVE_TOKENS: raw }, budget).ok).toBe(
        false,
      );
      expect(loadCompactionConfig({ MINICODE_COMPACTION_KEEP_RECENT_TOKENS: raw }, budget).ok).toBe(
        false,
      );
    }
    expect(loadCompactionConfig({ MINICODE_COMPACTION_ENABLED: "yes" }, budget).ok).toBe(false);
    expect(loadCompactionConfig({ MINICODE_COMPACTION_RESERVE_TOKENS: "1000" }, budget).ok).toBe(
      false,
    );
    expect(
      loadCompactionConfig(
        { MINICODE_COMPACTION_ENABLED: "false" },
        { ...budget, contextWindowTokens: 36384 },
      ).ok,
    ).toBe(false);
  });
});
