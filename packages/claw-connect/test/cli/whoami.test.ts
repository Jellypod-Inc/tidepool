import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runWhoami } from "../../src/cli/whoami.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-whoami-"));
}

describe("runWhoami", () => {
  it("returns peer fingerprint and sorted agent list", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    await runRegister({ configDir: dir, name: "rust-expert", localEndpoint: "http://127.0.0.1:38800" });

    const result = await runWhoami({ configDir: dir });
    expect(result.peerFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.agents.sort()).toEqual(["alice-dev", "rust-expert"]);
  });

  it("returns empty agents list when none registered", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await runWhoami({ configDir: dir });
    expect(result.peerFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.agents).toEqual([]);
  });

  it("throws if peer identity is missing", async () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "server.toml"), `
[server]
port = 9900
host = "0.0.0.0"
localPort = 9901
rateLimit = "100/hour"
streamTimeoutSeconds = 30
[connectionRequests]
mode = "deny"
[discovery]
providers = ["static"]
cacheTtlSeconds = 300
[validation]
mode = "warn"
`);
    await expect(runWhoami({ configDir: dir })).rejects.toThrow(/init/i);
  });
});
