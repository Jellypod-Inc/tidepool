import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-init-"));
}

describe("runInit", () => {
  it("creates server.toml, friends.toml, and remotes.toml with defaults", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    expect(fs.existsSync(path.join(dir, "server.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "friends.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "remotes.toml"))).toBe(true);
    const server = fs.readFileSync(path.join(dir, "server.toml"), "utf-8");
    expect(server).toMatch(/port = 9_?900/);
    expect(server).toContain("mode = \"warn\"");
  });

  it("is idempotent — second init does not overwrite edits", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    fs.appendFileSync(path.join(dir, "server.toml"), "\n# hand-edited\n");
    await runInit({ configDir: dir });
    const server = fs.readFileSync(path.join(dir, "server.toml"), "utf-8");
    expect(server).toContain("# hand-edited");
  });

  it("generates peer identity.crt + identity.key with 0o600 on the key", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const certPath = path.join(dir, "identity.crt");
    const keyPath = path.join(dir, "identity.key");
    expect(fs.existsSync(certPath)).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(true);
    const pem = fs.readFileSync(certPath, "utf-8");
    expect(pem).toContain("BEGIN CERTIFICATE");
    const keyMode = fs.statSync(keyPath).mode & 0o777;
    expect(keyMode).toBe(0o600);
  });

  it("is idempotent on the peer identity — second init does not regenerate", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const firstPem = fs.readFileSync(path.join(dir, "identity.crt"), "utf-8");
    await runInit({ configDir: dir });
    const secondPem = fs.readFileSync(path.join(dir, "identity.crt"), "utf-8");
    expect(secondPem).toBe(firstPem);
  });
});
