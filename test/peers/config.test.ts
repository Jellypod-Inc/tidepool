import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPeersConfig, writePeersConfig } from "../../src/peers/config.js";

describe("peers/config", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when file does not exist", () => {
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(cfg).toEqual({ peers: {} });
  });

  it("round-trips through TOML", () => {
    const filePath = path.join(dir, "peers.toml");
    const cfg = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice.example:9900",
          agents: ["writer", "rust-expert"],
        },
      },
    };
    writePeersConfig(filePath, cfg);
    const loaded = loadPeersConfig(filePath);
    expect(loaded).toEqual(cfg);
  });

  it("rejects malformed TOML with a useful error", () => {
    const filePath = path.join(dir, "peers.toml");
    fs.writeFileSync(
      filePath,
      `[peers.alice]\nfingerprint = "sha256:wronghex"\nendpoint = "https://alice:9900"\nagents = []\n`,
    );
    expect(() => loadPeersConfig(filePath)).toThrow(/fingerprint/);
  });
});
