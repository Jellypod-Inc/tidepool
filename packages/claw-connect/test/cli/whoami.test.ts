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
  it("returns one entry per registered agent with its fingerprint", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    await runRegister({ configDir: dir, name: "rust-expert", localEndpoint: "http://127.0.0.1:38800" });

    const entries = await runWhoami({ configDir: dir });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["alice-dev", "rust-expert"]);
    for (const e of entries) {
      expect(e.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("returns [] when no agents are registered", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    expect(await runWhoami({ configDir: dir })).toEqual([]);
  });
});
