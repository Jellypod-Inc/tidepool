import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscoveryCache } from "../../src/discovery/cache.js";
import type { DiscoveredAgent } from "../../src/discovery/types.js";

const agent1: DiscoveredAgent = {
  handle: "rust-expert",
  description: "Rust expert",
  endpoint: "https://bob.example.com:9900",
  agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
  status: "online",
};

const agent2: DiscoveredAgent = {
  handle: "ml-agent",
  description: "ML specialist",
  endpoint: "https://carol.example.com:9900",
  agentCardUrl: "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json",
  status: "online",
};

describe("DiscoveryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves agents by query key", () => {
    const cache = new DiscoveryCache(300);
    cache.set("rust", [agent1]);
    expect(cache.get("rust")).toEqual([agent1]);
  });

  it("returns null for missing cache key", () => {
    const cache = new DiscoveryCache(300);
    expect(cache.get("unknown")).toBeNull();
  });

  it("expires entries after TTL", () => {
    const cache = new DiscoveryCache(5);
    cache.set("rust", [agent1]);
    expect(cache.get("rust")).toEqual([agent1]);
    vi.advanceTimersByTime(6000);
    expect(cache.get("rust")).toBeNull();
  });

  it("does not expire entries before TTL", () => {
    const cache = new DiscoveryCache(10);
    cache.set("rust", [agent1]);
    vi.advanceTimersByTime(9000);
    expect(cache.get("rust")).toEqual([agent1]);
  });

  it("deduplicates agents by endpoint across multiple sets", () => {
    const duplicateAgent: DiscoveredAgent = {
      ...agent1,
      handle: "bobs-rust",
    };

    const result = DiscoveryCache.dedup([agent1, agent2, duplicateAgent]);
    expect(result).toHaveLength(2);
    expect(result[0].handle).toBe("rust-expert");
    expect(result[1].handle).toBe("ml-agent");
  });

  it("clears all entries", () => {
    const cache = new DiscoveryCache(300);
    cache.set("rust", [agent1]);
    cache.set("ml", [agent2]);
    cache.clear();
    expect(cache.get("rust")).toBeNull();
    expect(cache.get("ml")).toBeNull();
  });
});
