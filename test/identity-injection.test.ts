import { describe, expect, it } from "vitest";
import {
  injectMetadataFrom,
  resolveLocalHandleForRemoteSender,
  stampInboundMetadata,
  stripMetadataFrom,
} from "../src/identity-injection.js";
import { ThreadIndex } from "../src/thread-index.js";
import type { PeersConfig, RemoteAgent } from "../src/types.js";

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

describe("stripMetadataFrom", () => {
  it("removes metadata.from when present", () => {
    const body = {
      message: { messageId: "m1", metadata: { from: "claimed" } },
    };
    const result = stripMetadataFrom(body);
    expect(result.message.metadata).toEqual({});
  });

  it("preserves other metadata keys", () => {
    const body = {
      message: {
        messageId: "m1",
        metadata: { from: "claimed", custom: "v" },
      },
    };
    const result = stripMetadataFrom(body);
    expect(result.message.metadata).toEqual({ custom: "v" });
  });

  it("no-op when metadata.from absent", () => {
    const body = { message: { messageId: "m1", metadata: { custom: "v" } } };
    const result = stripMetadataFrom(body);
    expect(result.message.metadata).toEqual({ custom: "v" });
  });

  it("no-op when metadata absent", () => {
    const body = { message: { messageId: "m1" } };
    const result = stripMetadataFrom(body);
    expect(result).toEqual(body);
  });

  it("no-op when message missing", () => {
    const body = { other: "thing" };
    const result = stripMetadataFrom(body);
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

// -----------------------------------------------------------------------
// stampInboundMetadata
// -----------------------------------------------------------------------

const testPeers: PeersConfig = {
  peers: {
    alice: { did: "did:key:alice", endpoint: "https://a", agents: ["writer"] },
    bob:   { did: "did:key:bob",   endpoint: "https://b", agents: ["writer"] },
  },
};

describe("stampInboundMetadata", () => {
  // "me" is the local agent; alice and bob both have "writer" so they'll be
  // projected as alice/writer and bob/writer (scoped). "me" is unique so bare.
  const localAgents = ["me"];

  const makeOpts = (
    overrides: Partial<Parameters<typeof stampInboundMetadata>[1]> = {},
  ) => ({
    from: "alice/writer",
    self: "me",
    peers: testPeers,
    localAgents,
    threadIndex: new ThreadIndex({ maxThreads: 10, maxIdsPerThread: 10 }),
    ...overrides,
  });

  it("stamps metadata.from and metadata.self", () => {
    const body = { message: { messageId: "m1", contextId: "c1", metadata: {} } };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    expect(md.from).toBe("alice/writer");
    expect(md.self).toBe("me");
  });

  it("re-projects participants from DIDs to receiver-view handles", () => {
    const body = {
      message: {
        messageId: "m1",
        contextId: "c1",
        metadata: {
          participants: [
            "did:key:alice::writer",
            "did:key:bob::writer",
            "self::me",
          ],
        },
      },
    };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    // alice/writer and bob/writer are scoped because "writer" collides.
    // "me" is the local agent — unique, so projected bare.
    expect(md.participants).toEqual(["alice/writer", "bob/writer", "me"]);
  });

  it("re-projects addressed_to likewise", () => {
    const body = {
      message: {
        messageId: "m1",
        contextId: "c1",
        metadata: { addressed_to: ["did:key:alice::writer"] },
      },
    };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    expect(md.addressed_to).toEqual(["alice/writer"]);
  });

  it("passes unknown DIDs through opaquely — does not throw or drop", () => {
    const body = {
      message: {
        messageId: "m1",
        contextId: "c1",
        metadata: {
          participants: ["did:key:ghost::someone", "did:key:alice::writer"],
        },
      },
    };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    expect(md.participants).toEqual(["did:key:ghost::someone", "alice/writer"]);
  });

  it("records messageId into thread-index", () => {
    const idx = new ThreadIndex({ maxThreads: 10, maxIdsPerThread: 10 });
    const body = { message: { messageId: "m42", contextId: "ctx42", metadata: {} } };
    stampInboundMetadata(body, makeOpts({ threadIndex: idx }));
    expect(idx.has("ctx42", "m42")).toBe("present");
  });

  it("no-ops when body has no message", () => {
    const body: any = { other: "value" };
    const out = stampInboundMetadata(body, makeOpts());
    expect(out).toEqual({ other: "value" });
  });

  it("preserves unrelated metadata keys", () => {
    const body = {
      message: {
        messageId: "m1",
        contextId: "c1",
        metadata: { extra: "keep-me", participants: [] },
      },
    };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    expect(md.extra).toBe("keep-me");
  });

  it("leaves participants unchanged when not an array", () => {
    const body = {
      message: {
        messageId: "m1",
        contextId: "c1",
        metadata: { participants: "not-an-array" },
      },
    };
    const out = stampInboundMetadata(body, makeOpts());
    const md = (out as any).message.metadata;
    expect(md.participants).toBe("not-an-array");
  });
});
