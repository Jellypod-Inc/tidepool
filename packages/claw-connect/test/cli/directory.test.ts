import { describe, it, expect, afterEach } from "vitest";
import { runDirectoryServe } from "../../src/cli/directory.js";

describe("runDirectoryServe", () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
  });

  it("boots createDirectoryApp and returns stop()", async () => {
    const handle = await runDirectoryServe({ port: 0 });
    stopFn = handle.stop;

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect([200, 404]).toContain(res.status);
  });
});
