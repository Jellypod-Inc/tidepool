import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { peerCertPath, peerKeyPath, readPeerFingerprint } from "../src/identity-paths.js";
import { runInit } from "../src/cli/init.js";

describe("peer identity paths", () => {
  it("peerCertPath resolves to <configDir>/identity.crt", () => {
    expect(peerCertPath("/tmp/cc")).toBe(path.join("/tmp/cc", "identity.crt"));
  });

  it("peerKeyPath resolves to <configDir>/identity.key", () => {
    expect(peerKeyPath("/tmp/cc")).toBe(path.join("/tmp/cc", "identity.key"));
  });
});

describe("peer fingerprint", () => {
  it("readPeerFingerprint returns sha256:<hex> for a peer cert", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fp-"));
    await runInit({ configDir: dir });
    const fp = readPeerFingerprint(dir);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("readPeerFingerprint throws a clear error if identity is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fp-missing-"));
    expect(() => readPeerFingerprint(dir)).toThrow(/identity\.crt/i);
  });
});
