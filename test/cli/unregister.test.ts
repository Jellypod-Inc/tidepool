import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runUnregister } from "../../src/cli/unregister.js";
import { loadServerConfig } from "../../src/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-unregister-"));
}

describe("runUnregister", () => {
  it("removes the named agent from server.toml", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice",
    });
    await runRegister({
      configDir: dir,
      name: "bob",
    });

    await runUnregister({ configDir: dir, name: "alice" });

    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents.alice).toBeUndefined();
    expect(cfg.agents.bob).toBeDefined();
  });

  it("throws a helpful error when the agent is not registered", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice",
    });
    await expect(
      runUnregister({ configDir: dir, name: "ghost" }),
    ).rejects.toThrow(/not registered.*have: alice/);
  });

  it("throws when server.toml does not exist", async () => {
    const dir = tmp();
    await expect(
      runUnregister({ configDir: dir, name: "alice" }),
    ).rejects.toThrow(/server\.toml not found/);
  });
});
