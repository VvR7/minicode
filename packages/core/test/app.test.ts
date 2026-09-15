import { describe, expect, test } from "bun:test";

import { CoreApp } from "../src/app.ts";

describe("CoreApp", () => {
  test("starts once and stops idempotently", async () => {
    const app = new CoreApp({
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      homeDirectory: "/tmp/minicode-core-test",
    });

    const endpoint = app.start();
    expect(app.eventBus).toBeDefined();
    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.port).toBeGreaterThan(0);
    expect(() => app.start()).toThrow("core already started");

    const stopping = app.stop();
    expect(() => app.start()).toThrow("core already started");
    await stopping;
    await app.stop();
    expect(() => app.eventBus).toThrow("core is not started");
  });
});
