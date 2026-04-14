import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runStatus } from "../../src/cli/status.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-"));
}

describe("runStatus", () => {
  it("returns a multi-line string containing server info, agent count, friend count", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28800",
    });
    const out = await runStatus({ configDir: dir });
    expect(out).toContain("Claw Connect Status");
    expect(out).toContain("alice-dev");
    expect(out).toContain("0 friends");
  });
});
