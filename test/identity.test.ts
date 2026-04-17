import { describe, it, expect } from "vitest";
import { generateIdentity, getFingerprint } from "../src/identity.js";
import forge from "node-forge";
import fs from "fs";
import path from "path";
import os from "os";

describe("generateIdentity", () => {
  it("creates a self-signed cert and private key", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
    const certPath = path.join(tmpDir, "identity.crt");
    const keyPath = path.join(tmpDir, "identity.key");

    const identity = await generateIdentity({
      name: "test-agent",
      certPath,
      keyPath,
    });

    // Files exist
    expect(fs.existsSync(certPath)).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(true);

    // Cert is valid PEM
    const certPem = fs.readFileSync(certPath, "utf-8");
    const cert = forge.pki.certificateFromPem(certPem);
    expect(cert.subject.getField("CN").value).toBe("test-agent");

    // Fingerprint is a sha256 hex string
    expect(identity.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(identity.name).toBe("test-agent");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("getFingerprint", () => {
  it("computes sha256 fingerprint from PEM cert", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
    const certPath = path.join(tmpDir, "identity.crt");
    const keyPath = path.join(tmpDir, "identity.key");

    const identity = await generateIdentity({
      name: "fp-test",
      certPath,
      keyPath,
    });

    const certPem = fs.readFileSync(certPath, "utf-8");
    const fingerprint = getFingerprint(certPem);

    expect(fingerprint).toBe(identity.fingerprint);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
