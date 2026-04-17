import { describe, it, expect } from "vitest";
import { StaticProvider } from "../../src/discovery/static-provider.js";
import type { StaticPeer } from "../../src/types.js";

const peers: Record<string, StaticPeer> = {
  "bob-rust": {
    endpoint: "https://bob.example.com:9900",
    agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
    description: "Bob's Rust expert agent",
  },
  "carols-ml": {
    endpoint: "https://carol.example.com:9900",
    agentCardUrl: "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json",
    description: "Carol's ML specialist",
  },
};

describe("StaticProvider", () => {
  it("has name 'static'", () => {
    const provider = new StaticProvider(peers);
    expect(provider.name).toBe("static");
  });

  it("returns all peers on empty query", async () => {
    const provider = new StaticProvider(peers);
    const results = await provider.search({});

    expect(results).toHaveLength(2);
    expect(results[0].handle).toBe("bob-rust");
    expect(results[0].endpoint).toBe("https://bob.example.com:9900");
    expect(results[0].status).toBe("offline");
    expect(results[1].handle).toBe("carols-ml");
  });

  it("filters by query string matching description", async () => {
    const provider = new StaticProvider(peers);
    const results = await provider.search({ query: "rust" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("bob-rust");
  });

  it("filters by query string matching handle", async () => {
    const provider = new StaticProvider(peers);
    const results = await provider.search({ query: "carol" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("carols-ml");
  });

  it("filters by exact handle", async () => {
    const provider = new StaticProvider(peers);
    const results = await provider.search({ handle: "bob-rust" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("bob-rust");
  });

  it("resolves a known handle", async () => {
    const provider = new StaticProvider(peers);
    const result = await provider.resolve("bob-rust");

    expect(result).not.toBeNull();
    expect(result!.handle).toBe("bob-rust");
    expect(result!.endpoint).toBe("https://bob.example.com:9900");
  });

  it("returns null for unknown handle", async () => {
    const provider = new StaticProvider(peers);
    const result = await provider.resolve("unknown");
    expect(result).toBeNull();
  });

  it("advertise and deadvertise are no-ops", async () => {
    const provider = new StaticProvider(peers);
    await provider.advertise({
      handle: "test",
      description: "test",
      endpoint: "https://test.com",
      agentCardUrl: "https://test.com/.well-known/agent-card.json",
      status: "online",
    });
    await provider.deadvertise();
  });
});
