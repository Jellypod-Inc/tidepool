import { describe, it, expect } from "vitest";
import path from "path";
import { peerCertPath, peerKeyPath } from "../src/identity-paths.js";

describe("peer identity paths", () => {
  it("peerCertPath resolves to <configDir>/identity.crt", () => {
    expect(peerCertPath("/tmp/cc")).toBe(path.join("/tmp/cc", "identity.crt"));
  });

  it("peerKeyPath resolves to <configDir>/identity.key", () => {
    expect(peerKeyPath("/tmp/cc")).toBe(path.join("/tmp/cc", "identity.key"));
  });
});
