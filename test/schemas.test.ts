import { describe, it, expect } from "vitest";
import { PeersConfigSchema } from "../src/schemas.js";

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
