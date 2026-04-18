import { describe, it, expect } from "vitest";
import {
  PeersConfigSchema,
  BroadcastRequestSchema,
  BroadcastResponseSchema,
} from "../src/schemas.js";

describe("PeersConfigSchema", () => {
  it("accepts a peer with fingerprint only (DID omitted)", () => {
    const input = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice.example:9900",
          agents: ["writer", "rust-expert"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).not.toThrow();
  });

  it("accepts a peer with both did and fingerprint", () => {
    const input = {
      peers: {
        bob: {
          did: "did:dht:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          fingerprint: "sha256:" + "b".repeat(64),
          endpoint: "https://bob.example:9900",
          agents: ["trader"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).not.toThrow();
  });

  it("rejects a peer with neither did nor fingerprint", () => {
    const input = {
      peers: {
        anon: {
          endpoint: "https://anon:9900",
          agents: ["agent"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).toThrow();
  });

  it("defaults empty agents list", () => {
    const parsed = PeersConfigSchema.parse({
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice:9900",
        },
      },
    });
    expect(parsed.peers.alice.agents).toEqual([]);
  });

  it("rejects malformed fingerprint", () => {
    const input = {
      peers: {
        x: {
          fingerprint: "sha256:nothex",
          endpoint: "https://x:9900",
          agents: [],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).toThrow();
  });
});

describe("Broadcast schemas", () => {
  // Valid UUIDs for tests (v4, RFC 4122 compliant)
  const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
  const UUID_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

  it("accepts a minimal request", () => {
    const req = BroadcastRequestSchema.parse({
      peers: ["alice"],
      text: "hi",
    });
    expect(req.peers).toEqual(["alice"]);
    expect(req.text).toBe("hi");
  });

  it("rejects empty peers array", () => {
    expect(() => BroadcastRequestSchema.parse({ peers: [], text: "hi" }))
      .toThrow();
  });

  it("rejects empty text", () => {
    expect(() => BroadcastRequestSchema.parse({ peers: ["alice"], text: "" }))
      .toThrow();
  });

  it("accepts addressed_to and in_reply_to", () => {
    const req = BroadcastRequestSchema.parse({
      peers: ["a", "b"],
      text: "x",
      addressed_to: ["a"],
      in_reply_to: "msg-1",
    });
    expect(req.addressed_to).toEqual(["a"]);
    expect(req.in_reply_to).toBe("msg-1");
  });

  it("validates response shape with per-peer delivery", () => {
    const resp = BroadcastResponseSchema.parse({
      context_id: UUID_A,
      message_id: UUID_B,
      results: [
        { peer: "alice", delivery: "accepted" },
        {
          peer: "bob",
          delivery: "failed",
          reason: { kind: "peer-unreachable", message: "timeout" },
        },
      ],
    });
    expect(resp.results).toHaveLength(2);
    expect(resp.results[1].reason?.kind).toBe("peer-unreachable");
  });

  it("rejects invalid context_id (not UUID)", () => {
    expect(() =>
      BroadcastResponseSchema.parse({
        context_id: "not-a-uuid",
        message_id: UUID_B,
        results: [],
      }),
    ).toThrow();
  });

  it("rejects unknown delivery enum value", () => {
    expect(() =>
      BroadcastResponseSchema.parse({
        context_id: UUID_A,
        message_id: UUID_B,
        results: [{ peer: "alice", delivery: "maybe" }],
      }),
    ).toThrow();
  });
});
