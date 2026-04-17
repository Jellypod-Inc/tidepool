import { describe, it, expect, vi } from "vitest";
import { DiscoveryRegistry } from "../../src/discovery/registry.js";
import type { DiscoveredAgent, DiscoveryProvider } from "../../src/discovery/types.js";

function createMockProvider(
  name: string,
  agents: DiscoveredAgent[],
): DiscoveryProvider {
  return {
    name,
    advertise: vi.fn(),
    deadvertise: vi.fn(),
    search: vi.fn(async (query: { query?: string; handle?: string }) => {
      if (query.handle) {
        return agents.filter((a) => a.handle === query.handle);
      }
      if (query.query) {
        const q = query.query.toLowerCase();
        return agents.filter(
          (a) =>
            a.handle.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        );
      }
      return agents;
    }),
    resolve: vi.fn(async (handle: string) => {
      return agents.find((a) => a.handle === handle) ?? null;
    }),
  };
}

const agentA: DiscoveredAgent = {
  handle: "rust-expert",
  description: "Rust expert",
  endpoint: "https://bob.example.com:9900",
  agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
  status: "online",
};

const agentB: DiscoveredAgent = {
  handle: "ml-agent",
  description: "ML specialist",
  endpoint: "https://carol.example.com:9900",
  agentCardUrl: "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json",
  status: "online",
};

const agentADuplicate: DiscoveredAgent = {
  handle: "bobs-rust",
  description: "Bob's Rust agent",
  endpoint: "https://bob.example.com:9900",
  agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
  status: "offline",
};

describe("DiscoveryRegistry", () => {
  it("queries all providers and merges results", async () => {
    const provider1 = createMockProvider("static", [agentA]);
    const provider2 = createMockProvider("directory", [agentB]);
    const registry = new DiscoveryRegistry([provider1, provider2], 300);

    const results = await registry.search({});

    expect(results).toHaveLength(2);
    expect(results.map((a) => a.handle)).toContain("rust-expert");
    expect(results.map((a) => a.handle)).toContain("ml-agent");
  });

  it("deduplicates results by endpoint", async () => {
    const provider1 = createMockProvider("static", [agentA]);
    const provider2 = createMockProvider("mdns", [agentADuplicate, agentB]);
    const registry = new DiscoveryRegistry([provider1, provider2], 300);

    const results = await registry.search({});

    expect(results).toHaveLength(2);
    expect(results.find((a) => a.endpoint === "https://bob.example.com:9900")!.handle).toBe("rust-expert");
  });

  it("caches search results", async () => {
    const provider = createMockProvider("static", [agentA]);
    const registry = new DiscoveryRegistry([provider], 300);

    await registry.search({ query: "rust" });
    await registry.search({ query: "rust" });

    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it("resolve tries providers in order until found", async () => {
    const provider1 = createMockProvider("static", []);
    const provider2 = createMockProvider("directory", [agentB]);
    const registry = new DiscoveryRegistry([provider1, provider2], 300);

    const result = await registry.resolve("ml-agent");

    expect(result).not.toBeNull();
    expect(result!.handle).toBe("ml-agent");
  });

  it("resolve returns null when no provider has the handle", async () => {
    const provider1 = createMockProvider("static", []);
    const registry = new DiscoveryRegistry([provider1], 300);

    const result = await registry.resolve("unknown");
    expect(result).toBeNull();
  });

  it("advertises to all providers", async () => {
    const provider1 = createMockProvider("static", []);
    const provider2 = createMockProvider("directory", []);
    const registry = new DiscoveryRegistry([provider1, provider2], 300);

    await registry.advertise(agentA);

    expect(provider1.advertise).toHaveBeenCalledWith(agentA);
    expect(provider2.advertise).toHaveBeenCalledWith(agentA);
  });

  it("deadvertises from all providers", async () => {
    const provider1 = createMockProvider("static", []);
    const provider2 = createMockProvider("directory", []);
    const registry = new DiscoveryRegistry([provider1, provider2], 300);

    await registry.deadvertise();

    expect(provider1.deadvertise).toHaveBeenCalled();
    expect(provider2.deadvertise).toHaveBeenCalled();
  });

  it("handles provider errors gracefully during search", async () => {
    const failingProvider: DiscoveryProvider = {
      name: "broken",
      advertise: vi.fn(),
      deadvertise: vi.fn(),
      search: vi.fn(async () => {
        throw new Error("network error");
      }),
      resolve: vi.fn(async () => null),
    };
    const goodProvider = createMockProvider("static", [agentA]);
    const registry = new DiscoveryRegistry([failingProvider, goodProvider], 300);

    const results = await registry.search({});

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("rust-expert");
  });
});
