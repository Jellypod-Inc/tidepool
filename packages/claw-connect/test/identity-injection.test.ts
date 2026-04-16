import { describe, expect, it } from "vitest";
import {
  injectMetadataFrom,
  resolveLocalHandleForRemoteSender,
} from "../src/identity-injection.js";
import type { RemoteAgent } from "../src/types.js";

describe("injectMetadataFrom", () => {
  it("sets metadata.from on a message body", () => {
    const body = { message: { messageId: "m1", parts: [] } };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata).toEqual({ from: "alice" });
  });

  it("overwrites caller-supplied metadata.from", () => {
    const body = {
      message: { messageId: "m1", parts: [], metadata: { from: "evil" } },
    };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata.from).toBe("alice");
  });

  it("preserves other metadata keys", () => {
    const body = {
      message: { messageId: "m1", parts: [], metadata: { custom: "v" } },
    };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata).toEqual({ custom: "v", from: "alice" });
  });

  it("leaves body unchanged if message is missing", () => {
    const body = { other: "thing" };
    const result = injectMetadataFrom(body, "alice");
    expect(result).toEqual(body);
  });
});

describe("resolveLocalHandleForRemoteSender", () => {
  const remotes: RemoteAgent[] = [
    {
      localHandle: "alice-from-acme",
      remoteEndpoint: "https://acme.example",
      remoteTenant: "alice",
      certFingerprint: "FP-ACME",
    },
    {
      localHandle: "bob-from-globex",
      remoteEndpoint: "https://globex.example",
      remoteTenant: "bob",
      certFingerprint: "FP-GLOBEX",
    },
  ];

  it("resolves by fingerprint + sender agent name", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "alice"),
    ).toBe("alice-from-acme");
  });

  it("returns null when fingerprint matches but sender agent name does not", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "bob"),
    ).toBeNull();
  });

  it("returns null when fingerprint does not match", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-UNKNOWN", "alice"),
    ).toBeNull();
  });
});
