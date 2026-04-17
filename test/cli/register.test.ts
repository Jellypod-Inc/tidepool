import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { loadServerConfig } from "../../src/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-register-"));
}

describe("runRegister", () => {
  it("appends agent to server.toml and returns the peer fingerprint", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await runRegister({
      configDir: dir,
      name: "alice-dev",
    });

    expect(result.peerFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].rateLimit).toBe("50/hour");
  });

  it("does NOT create per-agent cert files", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
    });
    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.crt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.key"))).toBe(false);
  });

  it("throws a clear error if peer identity is missing", async () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    // deliberately skip init — no peer cert
    await expect(
      runRegister({
        configDir: dir,
        name: "alice-dev",
      }),
    ).rejects.toThrow(/init/i);
  });

  it("refuses to overwrite an existing agent unless --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev" });
    await expect(
      runRegister({ configDir: dir, name: "alice-dev" }),
    ).rejects.toThrow(/already registered/i);
  });

  it("overwrites the agent entry when --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
      rateLimit: "10/hour",
    });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
      rateLimit: "20/hour",
      force: true,
    });
    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].rateLimit).toBe("20/hour");
  });
});
