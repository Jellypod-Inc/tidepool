import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";
import { DiscoveryCache } from "./cache.js";

export class DiscoveryRegistry {
  private providers: DiscoveryProvider[];
  private cache: DiscoveryCache;

  constructor(providers: DiscoveryProvider[], cacheTtlSeconds: number) {
    this.providers = providers;
    this.cache = new DiscoveryCache(cacheTtlSeconds);
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const allResults: DiscoveredAgent[] = [];

    const providerResults = await Promise.allSettled(
      this.providers.map((p) => p.search(query)),
    );

    for (const result of providerResults) {
      if (result.status === "fulfilled") {
        allResults.push(...result.value);
      }
    }

    const deduped = DiscoveryCache.dedup(allResults);
    this.cache.set(cacheKey, deduped);
    return deduped;
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    for (const provider of this.providers) {
      try {
        const result = await provider.resolve(handle);
        if (result) return result;
      } catch {
        // Try next provider.
      }
    }
    return null;
  }

  async advertise(agent: DiscoveredAgent): Promise<void> {
    await Promise.allSettled(
      this.providers.map((p) => p.advertise(agent)),
    );
  }

  async deadvertise(): Promise<void> {
    await Promise.allSettled(
      this.providers.map((p) => p.deadvertise()),
    );
  }
}
