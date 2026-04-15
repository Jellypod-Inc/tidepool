import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { runStop } from "../../src/cli/stop.js";
import { PID_FILENAME } from "../../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-stop-"));
}

describe("runStop", () => {
  it("reports not-running when PID file absent", async () => {
    const dir = tmp();
    const result = await runStop({ configDir: dir });
    expect(result).toEqual({ action: "not-running" });
  });

  it("cleans up stale PID file and reports not-running", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, PID_FILENAME), "999999");
    const result = await runStop({ configDir: dir });
    expect(result).toEqual({ action: "not-running" });
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });

  it("sends SIGTERM to a live process and removes PID file", async () => {
    const dir = tmp();
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(dir, PID_FILENAME), String(child.pid));

    const result = await runStop({ configDir: dir, gracePeriodMs: 1000 });
    expect(result.action).toBe("stopped");
    expect(result.pid).toBe(child.pid);
    expect(result.forced).toBe(false);
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });
});
