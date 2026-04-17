import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runServe } from "../../src/cli/serve.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-serve-"));
}

describe("runServe (programmatic)", () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
  });

  it("starts the server and returns a stop() handle; /.well-known/agent-card.json responds", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({
      configDir: dir,
      name: "alice-dev",
    });

    const serverToml = fs
      .readFileSync(path.join(dir, "server.toml"), "utf-8")
      .replace(/port = [0-9_]+/, "port = 48900")
      .replace(/localPort = [0-9_]+/, "localPort = 48901");
    fs.writeFileSync(path.join(dir, "server.toml"), serverToml);

    const handle = await runServe({ configDir: dir });
    stopFn = handle.stop;

    const res = await fetch("http://127.0.0.1:48901/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = (await res.json()) as { skills: { id: string }[] };
    expect(card.skills.map((s) => s.id)).toContain("alice-dev");
  });
});
