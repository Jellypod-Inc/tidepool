import type { DiscoveredAgent } from "./types.js";

interface CacheEntry {
  agents: DiscoveredAgent[];
  expiresAt: number;
}

export class DiscoveryCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  set(key: string, agents: DiscoveredAgent[]): void {
    this.entries.set(key, {
      agents,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get(key: string): DiscoveredAgent[] | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    return entry.agents;
  }

  clear(): void {
    this.entries.clear();
  }

  static dedup(agents: DiscoveredAgent[]): DiscoveredAgent[] {
    const seen = new Set<string>();
    const result: DiscoveredAgent[] = [];

    for (const agent of agents) {
      if (!seen.has(agent.endpoint)) {
        seen.add(agent.endpoint);
        result.push(agent);
      }
    }

    return result;
  }
}
