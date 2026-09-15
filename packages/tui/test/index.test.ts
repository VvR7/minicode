import { describe, expect, test } from "bun:test";

import * as tui from "../src/index.ts";

describe("TUI public exports", () => {
  test("exports the app, model and options APIs", () => {
    expect(tui.TuiApp).toBeDefined();
    expect(tui.TuiModel).toBeDefined();
    expect(tui.parseTuiArgs).toBeDefined();
    expect(tui.EventLog).toBeDefined();
    expect(tui.formatChatHelp).toBeDefined();
    expect(tui.createSelectorState).toBeDefined();
    expect(tui.formatStatus).toBeDefined();
  });
});
