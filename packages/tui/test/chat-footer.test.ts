import { describe, expect, test } from "bun:test";
import type { TuiSnapshot } from "../src/model.ts";
import {
  formatContext,
  formatModel,
  formatRuntime,
  formatTokenCount,
} from "../src/widgets/chat-footer.ts";

const snapshot: TuiSnapshot = {
  connection: "connected",
  permission: undefined,
  permissionSelection: "allow_once",
  run: "idle",
  compacting: false,
  session: undefined,
  activeRunId: undefined,
  readOnly: false,
  lines: [],
  notice: undefined,
  model: "deepseek-flash",
  contextUsedTokens: 110_251,
  contextWindowTokens: 200_000,
};

describe("chat footer", () => {
  test("formats compact token counts and the current context ratio", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(2_125)).toBe("2.1k");
    expect(formatTokenCount(106_094)).toBe("106k");
    expect(formatContext(snapshot)).toBe("context 110k/200k 55.1%");
  });

  test("shows model and runtime placeholders without inventing state", () => {
    expect(formatModel(snapshot)).toBe("deepseek-flash");
    expect(formatRuntime(snapshot)).toBe("session -------- · connected · idle");
    expect(
      formatContext({ ...snapshot, contextUsedTokens: undefined, contextWindowTokens: undefined }),
    ).toBe("context --/--");
  });
});
