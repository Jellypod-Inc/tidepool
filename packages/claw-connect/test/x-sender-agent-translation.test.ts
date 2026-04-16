import { describe, expect, it } from "vitest";
import { resolveLocalHandleForRemoteSender } from "../src/identity-injection.js";

// The wire-level assertion (full mTLS path) is exercised by the E2E in Task 14.
// Here we lock the unit-level resolution behavior the public-app handler relies on.
describe("public-app remote→local sender translation", () => {
  it("translates (fingerprint, sender-agent) → local handle", () => {
    const remotes = [
      {
        localHandle: "alice-from-acme",
        remoteEndpoint: "https://acme.example",
        remoteTenant: "alice",
        certFingerprint: "FP-ACME",
      },
    ];
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "alice"),
    ).toBe("alice-from-acme");
  });

  it("returns null when X-Sender-Agent not in remotes for that fingerprint", () => {
    const remotes = [
      {
        localHandle: "alice-from-acme",
        remoteEndpoint: "https://acme.example",
        remoteTenant: "alice",
        certFingerprint: "FP-ACME",
      },
    ];
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "carol"),
    ).toBeNull();
  });
});
