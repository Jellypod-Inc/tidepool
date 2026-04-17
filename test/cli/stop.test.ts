import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runStop } from "../../src/cli/stop.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-stop-"));
}

describe("runStop", () => {
  it("reports not-running when no config present", async () => {
    const dir = tmp();
    const result = await runStop({ configDir: dir });
    expect(result).toEqual({ action: "not-running" });
  });

  it("reports not-running when the local port is not in use", async () => {
    const dir = tmp();
    const result = await runStop({
      configDir: dir,
      localPortOverride: 9901,
      isPortInUse: async () => false,
    });
    expect(result).toEqual({ action: "not-running" });
  });

  it("reports stopped when HTTP shutdown succeeds and port releases", async () => {
    const dir = tmp();
    const calls: string[] = [];
    const result = await runStop({
      configDir: dir,
      localPortOverride: 9901,
      isPortInUse: async () => true,
      httpShutdown: async (url) => {
        calls.push(url);
        return true;
      },
      waitForPortFree: async () => true,
    });
    expect(result).toEqual({ action: "stopped" });
    expect(calls).toEqual(["http://127.0.0.1:9901/internal/shutdown"]);
  });

  it("reports unresponsive when port stays bound despite shutdown attempt", async () => {
    const dir = tmp();
    const result = await runStop({
      configDir: dir,
      localPortOverride: 9901,
      isPortInUse: async () => true,
      httpShutdown: async () => false,
      waitForPortFree: async () => false,
    });
    expect(result).toEqual({ action: "unresponsive", port: 9901 });
  });
});
