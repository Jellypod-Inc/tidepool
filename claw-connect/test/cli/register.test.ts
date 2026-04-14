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
  it("generates identity files and appends agent to server.toml", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28800",
    });

    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.crt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.key"))).toBe(true);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28800");
    expect(cfg.agents["alice-dev"].rateLimit).toBe("50/hour");
  });

  it("refuses to overwrite an existing agent unless --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    await expect(
      runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28801" }),
    ).rejects.toThrow(/already registered/i);
  });

  it("overwrites when --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const first = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28800",
    });
    const second = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28801",
      force: true,
    });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28801");
  });
});
