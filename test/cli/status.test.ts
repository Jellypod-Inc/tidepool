import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runStatus } from "../../src/cli/status.js";
import { writePeersConfig } from "../../src/peers/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-"));
}

describe("runStatus", () => {
  it("returns a multi-line string containing server info, agent count, peer count", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
    });
    const out = await runStatus({ configDir: dir });
    expect(out).toContain("Tidepool Status");
    expect(out).toContain("alice-dev");
    expect(out).toMatch(/Peers \(\d+\)/);
  });

  it("shows a recovery hint when the daemon is not running", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const out = await runStatus({ configDir: dir, localPortOverride: 1 });
    expect(out).toMatch(/Daemon: not running/);
    expect(out).toMatch(/claude-code:start/);
    expect(out).toMatch(/tidepool start/);
  });

  it("lists peers and their agents when peers.toml is populated", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    writePeersConfig(path.join(dir, "peers.toml"), {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice:9900",
          agents: ["writer", "rust-expert"],
        },
      },
    });
    const out = await runStatus({ configDir: dir, localPortOverride: 1 });
    expect(out).toMatch(/Peers \(1\)/);
    expect(out).toMatch(/alice/);
    expect(out).toMatch(/writer/);
    expect(out).toMatch(/rust-expert/);
  });
});
