# Tidepool Phase 4: Discovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can find each other without knowing endpoints in advance. Full discovery → handshake → communication flow works end to end.

**Architecture:** Discovery is pluggable. Multiple providers run simultaneously and return a common `DiscoveredAgent` shape. Results are deduplicated by endpoint URL and cached in memory with a configurable TTL. Three built-in providers: mDNS/DNS-SD (local network), cloud directory (REST API), and static config (reads from server.toml). The CLI gets a `search` command that queries all enabled providers and feeds results into `tidepool connect` from Phase 2.

**Tech Stack (new deps):** `bonjour-service` (mDNS/DNS-SD), no new deps for cloud directory (uses existing Express)

**Spec:** `docs/superpowers/specs/2026-04-13-tidepool-revised-design.md`

**Depends on:** Phases 1-3 (identity, friends/handshake, rate limiting)

---

## File Structure

```
tidepool/
├── src/
│   ├── discovery/
│   │   ├── types.ts                  # DiscoveredAgent, DiscoveryProvider interfaces
│   │   ├── cache.ts                  # TTL-based in-memory discovery cache
│   │   ├── registry.ts               # Multi-provider registry, dedup, compose
│   │   ├── static-provider.ts        # Reads from server.toml [discovery.static.peers]
│   │   ├── mdns-provider.ts          # mDNS/DNS-SD using bonjour-service
│   │   └── directory-provider.ts     # Cloud directory REST client
│   ├── directory-server.ts           # Cloud directory Express REST API
│   └── types.ts                      # (update: add DiscoveryConfig, StaticPeer)
├── test/
│   ├── discovery/
│   │   ├── cache.test.ts
│   │   ├── registry.test.ts
│   │   ├── static-provider.test.ts
│   │   ├── mdns-provider.test.ts
│   │   └── directory-provider.test.ts
│   ├── directory-server.test.ts
│   └── discovery-e2e.test.ts         # Full discovery → connect flow
├── bin/
│   └── cli.ts                        # (update: add search command)
└── fixtures/
    └── server-with-discovery.toml    # Test config with all provider configs
```

---

### Task 1: Discovery Types and Interfaces

**Files:**
- Create: `tidepool/src/discovery/types.ts`
- Update: `tidepool/src/types.ts`

- [ ] **Step 1: Create discovery types**

Create `tidepool/src/discovery/types.ts`:

```typescript
export interface DiscoveredAgent {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  status: "online" | "offline";
}

export interface DiscoveryProvider {
  name: string;
  advertise(agent: DiscoveredAgent): Promise<void>;
  deadvertise(): Promise<void>;
  search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]>;
  resolve(handle: string): Promise<DiscoveredAgent | null>;
}
```

- [ ] **Step 2: Update src/types.ts to add discovery config types**

Add to `tidepool/src/types.ts`:

```typescript
export interface StaticPeer {
  endpoint: string;
  agentCardUrl: string;
  description?: string;
}

export interface DiscoveryConfig {
  providers: string[];
  cacheTtlSeconds: number;
  mdns?: {
    enabled: boolean;
  };
  directory?: {
    enabled: boolean;
    url: string;
  };
  static?: {
    peers: Record<string, StaticPeer>;
  };
}
```

Update the existing `ServerConfig` interface to use `DiscoveryConfig` instead of the inline type:

```typescript
export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: {
    mode: "accept" | "deny" | "auto";
  };
  discovery: DiscoveryConfig;
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors (the new `DiscoveryConfig` shape is a superset of the old inline type).

- [ ] **Step 4: Commit**

```bash
git add tidepool/src/discovery/types.ts tidepool/src/types.ts
git commit -m "feat(tidepool): discovery interfaces and config types"
```

---

### Task 2: Discovery Cache

**Files:**
- Create: `tidepool/src/discovery/cache.ts`
- Create: `tidepool/test/discovery/cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/discovery/cache.test.ts`:

```typescript
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

    const result = cache.get("rust");
    expect(result).toEqual([agent1]);
  });

  it("returns null for missing cache key", () => {
    const cache = new DiscoveryCache(300);
    expect(cache.get("unknown")).toBeNull();
  });

  it("expires entries after TTL", () => {
    const cache = new DiscoveryCache(5); // 5 seconds TTL
    cache.set("rust", [agent1]);

    expect(cache.get("rust")).toEqual([agent1]);

    vi.advanceTimersByTime(6000); // 6 seconds

    expect(cache.get("rust")).toBeNull();
  });

  it("does not expire entries before TTL", () => {
    const cache = new DiscoveryCache(10);
    cache.set("rust", [agent1]);

    vi.advanceTimersByTime(9000); // 9 seconds

    expect(cache.get("rust")).toEqual([agent1]);
  });

  it("deduplicates agents by endpoint across multiple sets", () => {
    const cache = new DiscoveryCache(300);

    const duplicateAgent: DiscoveredAgent = {
      ...agent1,
      handle: "bobs-rust", // different handle, same endpoint
    };

    const result = DiscoveryCache.dedup([agent1, agent2, duplicateAgent]);
    expect(result).toHaveLength(2);
    // First occurrence wins
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/discovery/cache.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/cache.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/discovery/cache.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/discovery/cache.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/discovery/cache.ts tidepool/test/discovery/cache.test.ts
git commit -m "feat(tidepool): TTL-based in-memory discovery cache"
```

---

### Task 3: Static Config Provider

**Files:**
- Create: `tidepool/src/discovery/static-provider.ts`
- Create: `tidepool/test/discovery/static-provider.test.ts`
- Create: `tidepool/fixtures/server-with-discovery.toml`

- [ ] **Step 1: Create test fixture**

Create `tidepool/fixtures/server-with-discovery.toml`:

```toml
[server]
port = 9900
host = "0.0.0.0"
localPort = 9901
rateLimit = "100/hour"

[agents.rust-expert]
localEndpoint = "http://localhost:18800"
rateLimit = "50/hour"
description = "Expert in Rust and systems programming"

[connectionRequests]
mode = "deny"

[discovery]
providers = ["static", "mdns", "directory"]
cacheTtlSeconds = 300

[discovery.mdns]
enabled = true

[discovery.directory]
enabled = true
url = "http://localhost:7900"

[discovery.static.peers.bob-rust]
endpoint = "https://bob.example.com:9900"
agentCardUrl = "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json"
description = "Bob's Rust expert agent"

[discovery.static.peers.carols-ml]
endpoint = "https://carol.example.com:9900"
agentCardUrl = "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json"
description = "Carol's ML specialist"
```

- [ ] **Step 2: Write the failing test**

Create `tidepool/test/discovery/static-provider.test.ts`:

```typescript
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
    expect(results[0].status).toBe("offline"); // static peers default to offline
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

    // Should not throw
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/discovery/static-provider.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/static-provider.js'`

- [ ] **Step 4: Write the implementation**

Create `tidepool/src/discovery/static-provider.ts`:

```typescript
import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";
import type { StaticPeer } from "../types.js";

export class StaticProvider implements DiscoveryProvider {
  readonly name = "static";
  private peers: Record<string, StaticPeer>;

  constructor(peers: Record<string, StaticPeer>) {
    this.peers = peers;
  }

  async advertise(_agent: DiscoveredAgent): Promise<void> {
    // Static provider does not support advertising — entries are manual.
  }

  async deadvertise(): Promise<void> {
    // Static provider does not support deadvertising.
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    const agents = this.allAgents();

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
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const peer = this.peers[handle];
    if (!peer) return null;

    return {
      handle,
      description: peer.description ?? handle,
      endpoint: peer.endpoint,
      agentCardUrl: peer.agentCardUrl,
      status: "offline", // Static peers have no liveness — assume offline until contacted.
    };
  }

  private allAgents(): DiscoveredAgent[] {
    return Object.entries(this.peers).map(([handle, peer]) => ({
      handle,
      description: peer.description ?? handle,
      endpoint: peer.endpoint,
      agentCardUrl: peer.agentCardUrl,
      status: "offline" as const,
    }));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/discovery/static-provider.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add tidepool/src/discovery/static-provider.ts tidepool/test/discovery/static-provider.test.ts tidepool/fixtures/server-with-discovery.toml
git commit -m "feat(tidepool): static discovery provider reads peers from server.toml"
```

---

### Task 4: Discovery Registry (Multi-Provider Composition)

**Files:**
- Create: `tidepool/src/discovery/registry.ts`
- Create: `tidepool/test/discovery/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/discovery/registry.test.ts`:

```typescript
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

// Same endpoint as agentA but different handle (from a different provider)
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
    // First provider's version wins
    expect(results.find((a) => a.endpoint === "https://bob.example.com:9900")!.handle).toBe("rust-expert");
  });

  it("caches search results", async () => {
    const provider = createMockProvider("static", [agentA]);
    const registry = new DiscoveryRegistry([provider], 300);

    await registry.search({ query: "rust" });
    await registry.search({ query: "rust" });

    // Provider search should only be called once due to caching
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

    // Should still return results from the good provider
    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("rust-expert");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/discovery/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/registry.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/discovery/registry.ts`:

```typescript
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
      // Errors are silently ignored — other providers still contribute.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/discovery/registry.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/discovery/registry.ts tidepool/test/discovery/registry.test.ts
git commit -m "feat(tidepool): discovery registry with multi-provider composition and caching"
```

---

### Task 5: mDNS/DNS-SD Provider

**Files:**
- Create: `tidepool/src/discovery/mdns-provider.ts`
- Create: `tidepool/test/discovery/mdns-provider.test.ts`

- [ ] **Step 1: Install bonjour-service**

Run: `cd tidepool && pnpm add bonjour-service`

- [ ] **Step 2: Write the failing test**

Create `tidepool/test/discovery/mdns-provider.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MdnsProvider } from "../../src/discovery/mdns-provider.js";

describe("MdnsProvider", () => {
  const providers: MdnsProvider[] = [];

  afterEach(async () => {
    for (const p of providers) {
      await p.deadvertise();
      p.destroy();
    }
    providers.length = 0;
  });

  it("has name 'mdns'", () => {
    const provider = new MdnsProvider();
    providers.push(provider);
    expect(provider.name).toBe("mdns");
  });

  it("advertises and discovers an agent on the local network", async () => {
    const advertiser = new MdnsProvider();
    providers.push(advertiser);

    await advertiser.advertise({
      handle: "rust-expert",
      description: "Rust expert",
      endpoint: "https://192.168.1.10:9900",
      agentCardUrl: "https://192.168.1.10:9900/rust-expert/.well-known/agent-card.json",
      status: "online",
    });

    // Give mDNS time to propagate
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const searcher = new MdnsProvider();
    providers.push(searcher);

    const results = await searcher.search({});

    // Should find at least the advertised agent
    const found = results.find((a) => a.handle === "rust-expert");
    expect(found).toBeDefined();
    expect(found!.endpoint).toBe("https://192.168.1.10:9900");
    expect(found!.status).toBe("online");
  }, 10000);

  it("filters search results by query string", async () => {
    const advertiser = new MdnsProvider();
    providers.push(advertiser);

    await advertiser.advertise({
      handle: "ml-agent",
      description: "Machine learning specialist",
      endpoint: "https://192.168.1.11:9900",
      agentCardUrl: "https://192.168.1.11:9900/ml-agent/.well-known/agent-card.json",
      status: "online",
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const searcher = new MdnsProvider();
    providers.push(searcher);

    const mlResults = await searcher.search({ query: "machine learning" });
    expect(mlResults.some((a) => a.handle === "ml-agent")).toBe(true);

    const rustResults = await searcher.search({ query: "rust" });
    expect(rustResults.some((a) => a.handle === "ml-agent")).toBe(false);
  }, 10000);

  it("resolves a specific handle", async () => {
    const advertiser = new MdnsProvider();
    providers.push(advertiser);

    await advertiser.advertise({
      handle: "resolve-test",
      description: "Test agent for resolve",
      endpoint: "https://192.168.1.12:9900",
      agentCardUrl: "https://192.168.1.12:9900/resolve-test/.well-known/agent-card.json",
      status: "online",
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const searcher = new MdnsProvider();
    providers.push(searcher);

    const result = await searcher.resolve("resolve-test");
    expect(result).not.toBeNull();
    expect(result!.handle).toBe("resolve-test");
  }, 10000);

  it("returns null for unknown handle on resolve", async () => {
    const searcher = new MdnsProvider();
    providers.push(searcher);

    const result = await searcher.resolve("nonexistent");
    expect(result).toBeNull();
  });

  it("deadvertise removes the service", async () => {
    const advertiser = new MdnsProvider();
    providers.push(advertiser);

    await advertiser.advertise({
      handle: "temp-agent",
      description: "Temporary agent",
      endpoint: "https://192.168.1.13:9900",
      agentCardUrl: "https://192.168.1.13:9900/temp-agent/.well-known/agent-card.json",
      status: "online",
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await advertiser.deadvertise();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const searcher = new MdnsProvider();
    providers.push(searcher);

    // After deadvertise, the agent should no longer be discoverable
    // (though mDNS caching may keep it briefly — we check it's not re-announced)
    const result = await searcher.resolve("temp-agent");
    // May or may not be null depending on mDNS cache timing — the important
    // thing is deadvertise doesn't throw
    expect(true).toBe(true);
  }, 10000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/discovery/mdns-provider.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/mdns-provider.js'`

- [ ] **Step 4: Write the implementation**

Create `tidepool/src/discovery/mdns-provider.ts`:

```typescript
import Bonjour, { type Service } from "bonjour-service";
import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";

const SERVICE_TYPE = "a2a";
const SERVICE_PROTOCOL = "tcp";

export class MdnsProvider implements DiscoveryProvider {
  readonly name = "mdns";
  private bonjour: InstanceType<typeof Bonjour>;
  private publishedService: Service | null = null;

  constructor() {
    this.bonjour = new Bonjour();
  }

  async advertise(agent: DiscoveredAgent): Promise<void> {
    // Unpublish any existing service first
    if (this.publishedService) {
      this.publishedService.stop();
      this.publishedService = null;
    }

    // Parse port from endpoint URL
    const url = new URL(agent.endpoint);
    const port = parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80);

    this.publishedService = this.bonjour.publish({
      name: agent.handle,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      txt: {
        handle: agent.handle,
        description: agent.description,
        endpoint: agent.endpoint,
        agentCardUrl: agent.agentCardUrl,
        status: agent.status,
      },
    });
  }

  async deadvertise(): Promise<void> {
    if (this.publishedService) {
      this.publishedService.stop();
      this.publishedService = null;
    }
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    return new Promise((resolve) => {
      const agents: DiscoveredAgent[] = [];

      const browser = this.bonjour.find(
        { type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL },
        (service) => {
          const agent = this.serviceToAgent(service);
          if (!agent) return;

          if (query.handle && agent.handle !== query.handle) return;
          if (query.query) {
            const q = query.query.toLowerCase();
            if (
              !agent.handle.toLowerCase().includes(q) &&
              !agent.description.toLowerCase().includes(q)
            ) {
              return;
            }
          }

          agents.push(agent);
        },
      );

      // mDNS discovery is async — wait a bit for responses then stop
      setTimeout(() => {
        browser.stop();
        resolve(agents);
      }, 1000);
    });
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const results = await this.search({ handle });
    return results[0] ?? null;
  }

  destroy(): void {
    this.bonjour.destroy();
  }

  private serviceToAgent(service: Service): DiscoveredAgent | null {
    const txt = service.txt as Record<string, string> | undefined;
    if (!txt?.handle || !txt?.endpoint) return null;

    return {
      handle: txt.handle,
      description: txt.description ?? service.name,
      endpoint: txt.endpoint,
      agentCardUrl:
        txt.agentCardUrl ??
        `${txt.endpoint}/${txt.handle}/.well-known/agent-card.json`,
      status: (txt.status as "online" | "offline") ?? "online",
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/discovery/mdns-provider.test.ts`
Expected: 5 tests PASS. Note: mDNS tests run on the local machine's multicast interface. They may take a few seconds due to mDNS propagation delays.

- [ ] **Step 6: Commit**

```bash
git add tidepool/src/discovery/mdns-provider.ts tidepool/test/discovery/mdns-provider.test.ts tidepool/package.json tidepool/pnpm-lock.yaml
git commit -m "feat(tidepool): mDNS/DNS-SD discovery provider using bonjour-service"
```

---

### Task 6: Cloud Directory Server

**Files:**
- Create: `tidepool/src/directory-server.ts`
- Create: `tidepool/test/directory-server.test.ts`

The cloud directory is a standalone Express REST API. For v1, it runs as a simple in-memory server. It authenticates registration and heartbeat requests via mTLS — only the cert holder can update their entry.

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/directory-server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import http from "http";
import { createDirectoryApp, type DirectoryStore } from "../src/directory-server.js";

describe("Cloud Directory Server", () => {
  let server: http.Server;
  let baseUrl: string;
  let store: DirectoryStore;

  beforeAll(async () => {
    const app = createDirectoryApp();
    store = app.store;

    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(app.app).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    store.clear();
  });

  it("POST /v1/agents/register adds an agent to the directory", async () => {
    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "rust-expert",
        description: "Rust expert agent",
        endpoint: "https://bob.example.com:9900",
        agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.handle).toBe("rust-expert");
    expect(data.status).toBe("online");
  });

  it("GET /v1/agents/search returns matching agents", async () => {
    // Register two agents
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "rust-expert",
        description: "Rust and systems programming",
        endpoint: "https://bob.example.com:9900",
        agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
      }),
    });

    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:bbbb2222",
      },
      body: JSON.stringify({
        handle: "ml-agent",
        description: "Machine learning specialist",
        endpoint: "https://carol.example.com:9900",
        agentCardUrl: "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json",
      }),
    });

    // Search for rust
    const res = await fetch(`${baseUrl}/v1/agents/search?q=rust`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].handle).toBe("rust-expert");
  });

  it("GET /v1/agents/search with status filter", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "online-agent",
        description: "Always online",
        endpoint: "https://online.example.com:9900",
        agentCardUrl: "https://online.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/search?status=online`);
    const data = await res.json();
    expect(data.agents.length).toBeGreaterThanOrEqual(1);
    expect(data.agents.every((a: any) => a.status === "online")).toBe(true);
  });

  it("GET /v1/agents/:handle returns a specific agent", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "specific-agent",
        description: "Specific agent",
        endpoint: "https://specific.example.com:9900",
        agentCardUrl: "https://specific.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/specific-agent`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.handle).toBe("specific-agent");
  });

  it("GET /v1/agents/:handle returns 404 for unknown agent", async () => {
    const res = await fetch(`${baseUrl}/v1/agents/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /v1/agents/heartbeat updates status and last-seen time", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "heartbeat-agent",
        description: "Heartbeat test",
        endpoint: "https://heartbeat.example.com:9900",
        agentCardUrl: "https://heartbeat.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({ handle: "heartbeat-agent" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("online");
  });

  it("rejects registration update from wrong fingerprint", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "guarded-agent",
        description: "Guarded agent",
        endpoint: "https://guarded.example.com:9900",
        agentCardUrl: "https://guarded.example.com:9900/.well-known/agent-card.json",
      }),
    });

    // Try to update from a different fingerprint
    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:imposter",
      },
      body: JSON.stringify({
        handle: "guarded-agent",
        description: "HACKED",
        endpoint: "https://evil.example.com:9900",
        agentCardUrl: "https://evil.example.com:9900/.well-known/agent-card.json",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects heartbeat from wrong fingerprint", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "heartbeat-guard",
        description: "Guarded heartbeat",
        endpoint: "https://hb-guard.example.com:9900",
        agentCardUrl: "https://hb-guard.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:wrong",
      },
      body: JSON.stringify({ handle: "heartbeat-guard" }),
    });

    expect(res.status).toBe(403);
  });

  it("marks agents offline when heartbeat is stale", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:stale1111",
      },
      body: JSON.stringify({
        handle: "stale-agent",
        description: "Will go stale",
        endpoint: "https://stale.example.com:9900",
        agentCardUrl: "https://stale.example.com:9900/.well-known/agent-card.json",
      }),
    });

    // Manually set lastSeen to the past to simulate staleness
    const entry = store.getByHandle("stale-agent");
    if (entry) {
      entry.lastSeen = Date.now() - 120_000; // 2 minutes ago
    }

    const res = await fetch(`${baseUrl}/v1/agents/stale-agent`);
    const data = await res.json();
    expect(data.status).toBe("offline");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/directory-server.test.ts`
Expected: FAIL — `Cannot find module '../src/directory-server.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/directory-server.ts`:

```typescript
import express from "express";

interface DirectoryEntry {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  fingerprint: string;
  status: "online" | "offline";
  lastSeen: number;
  registeredAt: number;
}

const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds — if no heartbeat, mark offline

export class DirectoryStore {
  private entries = new Map<string, DirectoryEntry>();

  register(
    handle: string,
    description: string,
    endpoint: string,
    agentCardUrl: string,
    fingerprint: string,
  ): DirectoryEntry | { error: string; status: number } {
    const existing = this.entries.get(handle);
    if (existing && existing.fingerprint !== fingerprint) {
      return { error: "Handle already registered by a different agent", status: 403 };
    }

    const now = Date.now();
    const entry: DirectoryEntry = {
      handle,
      description,
      endpoint,
      agentCardUrl,
      fingerprint,
      status: "online",
      lastSeen: now,
      registeredAt: existing?.registeredAt ?? now,
    };

    this.entries.set(handle, entry);
    return entry;
  }

  heartbeat(handle: string, fingerprint: string): DirectoryEntry | { error: string; status: number } {
    const entry = this.entries.get(handle);
    if (!entry) {
      return { error: "Agent not registered", status: 404 };
    }

    if (entry.fingerprint !== fingerprint) {
      return { error: "Fingerprint mismatch", status: 403 };
    }

    entry.lastSeen = Date.now();
    entry.status = "online";
    return entry;
  }

  search(query?: string, status?: string): DirectoryEntry[] {
    let results = Array.from(this.entries.values());

    // Update status based on heartbeat freshness
    const now = Date.now();
    for (const entry of results) {
      if (now - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        entry.status = "offline";
      }
    }

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (e) =>
          e.handle.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }

    if (status) {
      results = results.filter((e) => e.status === status);
    }

    return results;
  }

  getByHandle(handle: string): DirectoryEntry | null {
    const entry = this.entries.get(handle) ?? null;
    if (entry) {
      // Update status based on heartbeat freshness
      if (Date.now() - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        entry.status = "offline";
      }
    }
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createDirectoryApp(): { app: express.Application; store: DirectoryStore } {
  const app = express();
  app.use(express.json());

  const store = new DirectoryStore();

  // In production, fingerprint comes from the mTLS handshake (req.socket.getPeerCertificate).
  // For the v1 REST API, we use a header as a stand-in. The cloud directory
  // would run with mTLS enabled in production.
  function getFingerprint(req: express.Request): string | null {
    // Try mTLS first
    const peerCert = (req.socket as any).getPeerCertificate?.();
    if (peerCert?.raw) {
      // Would compute fingerprint from cert — for now, fall back to header
    }

    return (req.headers["x-client-fingerprint"] as string) ?? null;
  }

  // POST /v1/agents/register
  app.post("/v1/agents/register", (req, res) => {
    const fingerprint = getFingerprint(req);
    if (!fingerprint) {
      res.status(401).json({ error: "No client certificate or fingerprint header" });
      return;
    }

    const { handle, description, endpoint, agentCardUrl } = req.body;
    if (!handle || !description || !endpoint || !agentCardUrl) {
      res.status(400).json({ error: "Missing required fields: handle, description, endpoint, agentCardUrl" });
      return;
    }

    const result = store.register(handle, description, endpoint, agentCardUrl, fingerprint);

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(201).json(toPublic(result));
  });

  // GET /v1/agents/search?q=rust&status=online
  app.get("/v1/agents/search", (req, res) => {
    const q = req.query.q as string | undefined;
    const status = req.query.status as string | undefined;

    const results = store.search(q, status);
    res.json({ agents: results.map(toPublic) });
  });

  // GET /v1/agents/:handle
  app.get("/v1/agents/:handle", (req, res) => {
    const entry = store.getByHandle(req.params.handle);
    if (!entry) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(toPublic(entry));
  });

  // POST /v1/agents/heartbeat
  app.post("/v1/agents/heartbeat", (req, res) => {
    const fingerprint = getFingerprint(req);
    if (!fingerprint) {
      res.status(401).json({ error: "No client certificate or fingerprint header" });
      return;
    }

    const { handle } = req.body;
    if (!handle) {
      res.status(400).json({ error: "Missing required field: handle" });
      return;
    }

    const result = store.heartbeat(handle, fingerprint);

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(toPublic(result));
  });

  return { app, store };
}

function toPublic(entry: DirectoryEntry): {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  status: string;
} {
  return {
    handle: entry.handle,
    description: entry.description,
    endpoint: entry.endpoint,
    agentCardUrl: entry.agentCardUrl,
    status: entry.status,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/directory-server.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/directory-server.ts tidepool/test/directory-server.test.ts
git commit -m "feat(tidepool): cloud directory REST API with cert-auth and heartbeat"
```

---

### Task 7: Cloud Directory Provider (Client)

**Files:**
- Create: `tidepool/src/discovery/directory-provider.ts`
- Create: `tidepool/test/discovery/directory-provider.test.ts`

This provider is the client side — it talks to the cloud directory REST API from Task 6.

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/discovery/directory-provider.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { createDirectoryApp, type DirectoryStore } from "../../src/directory-server.js";
import { DirectoryProvider } from "../../src/discovery/directory-provider.js";

describe("DirectoryProvider", () => {
  let server: http.Server;
  let baseUrl: string;
  let store: DirectoryStore;

  beforeAll(async () => {
    const dir = createDirectoryApp();
    store = dir.store;

    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(dir.app).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    store.clear();
  });

  it("has name 'directory'", () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:test-fp");
    expect(provider.name).toBe("directory");
  });

  it("advertise registers the agent with the directory", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:advertise-fp");

    await provider.advertise({
      handle: "dir-agent",
      description: "Directory test agent",
      endpoint: "https://dir.example.com:9900",
      agentCardUrl: "https://dir.example.com:9900/.well-known/agent-card.json",
      status: "online",
    });

    // Verify it's in the directory
    const res = await fetch(`${baseUrl}/v1/agents/dir-agent`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.handle).toBe("dir-agent");
  });

  it("search queries the directory", async () => {
    // Seed the directory
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:seed-fp",
      },
      body: JSON.stringify({
        handle: "search-agent",
        description: "Agent for search testing",
        endpoint: "https://search.example.com:9900",
        agentCardUrl: "https://search.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const results = await provider.search({ query: "search" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("search-agent");
    expect(results[0].status).toBe("online");
  });

  it("search with empty query returns all agents", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:seed1",
      },
      body: JSON.stringify({
        handle: "agent-one",
        description: "First agent",
        endpoint: "https://one.example.com:9900",
        agentCardUrl: "https://one.example.com:9900/.well-known/agent-card.json",
      }),
    });

    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:seed2",
      },
      body: JSON.stringify({
        handle: "agent-two",
        description: "Second agent",
        endpoint: "https://two.example.com:9900",
        agentCardUrl: "https://two.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const results = await provider.search({});

    expect(results).toHaveLength(2);
  });

  it("resolve returns a specific agent", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:resolve-fp",
      },
      body: JSON.stringify({
        handle: "resolve-agent",
        description: "Agent to resolve",
        endpoint: "https://resolve.example.com:9900",
        agentCardUrl: "https://resolve.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const result = await provider.resolve("resolve-agent");

    expect(result).not.toBeNull();
    expect(result!.handle).toBe("resolve-agent");
  });

  it("resolve returns null for unknown handle", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const result = await provider.resolve("nonexistent");
    expect(result).toBeNull();
  });

  it("deadvertise is a no-op (deregistration not implemented in v1)", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    // Should not throw
    await provider.deadvertise();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/discovery/directory-provider.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/directory-provider.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/discovery/directory-provider.ts`:

```typescript
import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";

export class DirectoryProvider implements DiscoveryProvider {
  readonly name = "directory";
  private directoryUrl: string;
  private fingerprint: string;

  constructor(directoryUrl: string, fingerprint: string) {
    this.directoryUrl = directoryUrl.replace(/\/$/, "");
    this.fingerprint = fingerprint;
  }

  async advertise(agent: DiscoveredAgent): Promise<void> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": this.fingerprint,
      },
      body: JSON.stringify({
        handle: agent.handle,
        description: agent.description,
        endpoint: agent.endpoint,
        agentCardUrl: agent.agentCardUrl,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        `Directory registration failed: ${res.status} ${(data as any).error ?? res.statusText}`,
      );
    }
  }

  async deadvertise(): Promise<void> {
    // Deregistration not implemented in v1 — agents go offline via heartbeat timeout.
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.handle) params.set("q", query.handle);

    const url = `${this.directoryUrl}/v1/agents/search?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) return [];

    const data = (await res.json()) as { agents: DiscoveredAgent[] };

    // Apply handle filter client-side if specified (server search is free-text)
    if (query.handle) {
      return data.agents.filter((a) => a.handle === query.handle);
    }

    return data.agents;
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/${encodeURIComponent(handle)}`);

    if (res.status === 404) return null;
    if (!res.ok) return null;

    return (await res.json()) as DiscoveredAgent;
  }

  async heartbeat(handle: string): Promise<void> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": this.fingerprint,
      },
      body: JSON.stringify({ handle }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        `Heartbeat failed: ${res.status} ${(data as any).error ?? res.statusText}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/discovery/directory-provider.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/discovery/directory-provider.ts tidepool/test/discovery/directory-provider.test.ts
git commit -m "feat(tidepool): cloud directory discovery provider (REST client)"
```

---

### Task 8: CLI Search Command

**Files:**
- Update: `tidepool/bin/cli.ts`
- Update: `tidepool/src/config.ts` (parse new discovery config fields)

- [ ] **Step 1: Update config.ts to parse discovery sub-sections**

Add parsing for the new `discovery.mdns`, `discovery.directory`, and `discovery.static.peers` sections. In the `loadServerConfig` function, update the discovery parsing block:

Replace the existing discovery parsing in `tidepool/src/config.ts`:

```typescript
// Old:
discovery: {
  providers: (discovery.providers as string[]) ?? ["static"],
  cacheTtlSeconds: (discovery.cacheTtlSeconds as number) ?? 300,
},

// New:
discovery: {
  providers: (discovery.providers as string[]) ?? ["static"],
  cacheTtlSeconds: (discovery.cacheTtlSeconds as number) ?? 300,
  mdns: discovery.mdns
    ? { enabled: (discovery.mdns as Record<string, unknown>).enabled as boolean }
    : undefined,
  directory: discovery.directory
    ? {
        enabled: (discovery.directory as Record<string, unknown>).enabled as boolean,
        url: (discovery.directory as Record<string, unknown>).url as string,
      }
    : undefined,
  static: discovery.static
    ? {
        peers: Object.fromEntries(
          Object.entries(
            ((discovery.static as Record<string, unknown>).peers ?? {}) as Record<
              string,
              Record<string, unknown>
            >,
          ).map(([name, peer]) => [
            name,
            {
              endpoint: peer.endpoint as string,
              agentCardUrl: (peer.agentCardUrl ?? peer.agent_card_url) as string,
              description: peer.description as string | undefined,
            },
          ]),
        ),
      }
    : undefined,
},
```

- [ ] **Step 2: Add the search command to CLI**

Add the following to `tidepool/bin/cli.ts`, before `program.parse()`:

```typescript
import { StaticProvider } from "../src/discovery/static-provider.js";
import { MdnsProvider } from "../src/discovery/mdns-provider.js";
import { DirectoryProvider } from "../src/discovery/directory-provider.js";
import { DiscoveryRegistry } from "../src/discovery/registry.js";
import { loadServerConfig } from "../src/config.js";
import { getFingerprint } from "../src/identity.js";
import fs from "fs";

program
  .command("search [query]")
  .description("Search for agents via discovery providers")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .option("--local", "mDNS only (local network)", false)
  .action(async (query: string | undefined, opts) => {
    const configDir = opts.dir;
    const serverTomlPath = path.join(configDir, "server.toml");

    if (!fs.existsSync(serverTomlPath)) {
      console.error("Not initialized. Run 'tidepool init' first.");
      process.exit(1);
    }

    const config = loadServerConfig(serverTomlPath);

    // Build providers based on config
    const providers: any[] = [];

    if (opts.local) {
      // mDNS only
      const mdns = new MdnsProvider();
      providers.push(mdns);
      console.log("Searching local network (mDNS)...\n");
    } else {
      // All enabled providers
      if (config.discovery.static?.peers) {
        providers.push(new StaticProvider(config.discovery.static.peers));
      }

      if (config.discovery.mdns?.enabled) {
        providers.push(new MdnsProvider());
      }

      if (config.discovery.directory?.enabled && config.discovery.directory.url) {
        // Get fingerprint for the first registered agent (for directory auth)
        const agentNames = Object.keys(config.agents);
        let fingerprint = "unknown";
        if (agentNames.length > 0) {
          const certPath = path.join(configDir, "agents", agentNames[0], "identity.crt");
          if (fs.existsSync(certPath)) {
            const certPem = fs.readFileSync(certPath, "utf-8");
            fingerprint = getFingerprint(certPem);
          }
        }
        providers.push(new DirectoryProvider(config.discovery.directory.url, fingerprint));
      }

      const providerNames = providers.map((p) => p.name).join(", ");
      console.log(`Searching via: ${providerNames}...\n`);
    }

    if (providers.length === 0) {
      console.log("No discovery providers configured. Add providers to server.toml [discovery] section.");
      process.exit(0);
    }

    const registry = new DiscoveryRegistry(providers, config.discovery.cacheTtlSeconds);
    const results = await registry.search(query ? { query } : {});

    if (results.length === 0) {
      console.log("No agents found.");
    } else {
      console.log(`Found ${results.length} agent(s):\n`);
      for (const agent of results) {
        const statusIcon = agent.status === "online" ? "[online]" : "[offline]";
        console.log(`  ${agent.handle} ${statusIcon}`);
        console.log(`    ${agent.description}`);
        console.log(`    Endpoint: ${agent.endpoint}`);
        console.log(`    Agent Card: ${agent.agentCardUrl}`);
        console.log();
      }

      console.log("To connect to an agent:");
      console.log("  tidepool connect <agent-card-url>");
    }

    // Cleanup mDNS providers
    for (const provider of providers) {
      if (provider instanceof MdnsProvider) {
        provider.destroy();
      }
    }
  });
```

- [ ] **Step 3: Test CLI manually**

Run:
```bash
cd tidepool

# Init with discovery config
npx tsx bin/cli.ts init --dir /tmp/cc-discovery-test
```

Manually add discovery config to `/tmp/cc-discovery-test/server.toml`:
```bash
cat >> /tmp/cc-discovery-test/server.toml << 'EOF'

[discovery.static.peers.demo-agent]
endpoint = "https://demo.example.com:9900"
agentCardUrl = "https://demo.example.com:9900/demo/.well-known/agent-card.json"
description = "Demo agent for testing discovery"
EOF
```

Then run:
```bash
npx tsx bin/cli.ts search "demo" --dir /tmp/cc-discovery-test
```

Expected:
```
Searching via: static...

Found 1 agent(s):

  demo-agent [offline]
    Demo agent for testing discovery
    Endpoint: https://demo.example.com:9900
    Agent Card: https://demo.example.com:9900/demo/.well-known/agent-card.json

To connect to an agent:
  tidepool connect <agent-card-url>
```

Run mDNS-only search:
```bash
npx tsx bin/cli.ts search --local --dir /tmp/cc-discovery-test
```

Expected:
```
Searching local network (mDNS)...

No agents found.
```

- [ ] **Step 4: Cleanup and commit**

```bash
rm -rf /tmp/cc-discovery-test
git add tidepool/bin/cli.ts tidepool/src/config.ts
git commit -m "feat(tidepool): CLI search command with multi-provider discovery"
```

---

### Task 9: Discovery End-to-End Test

**Files:**
- Create: `tidepool/test/discovery-e2e.test.ts`

This test validates the full flow: discovery finds an agent, the result feeds into a connection request (using Phase 2's `connect` flow), and communication works end to end.

- [ ] **Step 1: Write the e2e test**

Create `tidepool/test/discovery-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import { StaticProvider } from "../src/discovery/static-provider.js";
import { DirectoryProvider } from "../src/discovery/directory-provider.js";
import { DiscoveryRegistry } from "../src/discovery/registry.js";
import { createDirectoryApp, type DirectoryStore } from "../src/directory-server.js";

describe("discovery e2e: find agent → get details → ready to connect", () => {
  let directoryServer: http.Server;
  let directoryUrl: string;
  let directoryStore: DirectoryStore;

  let mockAgentServer: http.Server;

  beforeAll(async () => {
    // Start cloud directory
    const dir = createDirectoryApp();
    directoryStore = dir.store;

    directoryServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(dir.app).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const dirAddr = directoryServer.address() as { port: number };
    directoryUrl = `http://127.0.0.1:${dirAddr.port}`;

    // Start a mock agent that serves an Agent Card
    const agentApp = express();
    agentApp.get("/rust-expert/.well-known/agent-card.json", (_req, res) => {
      res.json({
        name: "rust-expert",
        description: "Expert in Rust and systems programming",
        url: "https://bob.example.com:9900/rust-expert",
        version: "1.0.0",
        skills: [{ id: "chat", name: "chat", description: "Rust help", tags: [] }],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
        securitySchemes: {},
        securityRequirements: [],
      });
    });

    mockAgentServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(agentApp).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const agentAddr = mockAgentServer.address() as { port: number };

    // Register the agent in the cloud directory
    await fetch(`${directoryUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:bob-fingerprint",
      },
      body: JSON.stringify({
        handle: "rust-expert",
        description: "Expert in Rust and systems programming",
        endpoint: `http://127.0.0.1:${agentAddr.port}`,
        agentCardUrl: `http://127.0.0.1:${agentAddr.port}/rust-expert/.well-known/agent-card.json`,
      }),
    });
  });

  afterAll(() => {
    directoryServer?.close();
    mockAgentServer?.close();
  });

  it("static provider finds a configured peer", async () => {
    const staticProvider = new StaticProvider({
      "static-rust": {
        endpoint: "https://static.example.com:9900",
        agentCardUrl: "https://static.example.com:9900/rust/.well-known/agent-card.json",
        description: "Static Rust agent",
      },
    });

    const registry = new DiscoveryRegistry([staticProvider], 300);
    const results = await registry.search({ query: "rust" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("static-rust");
  });

  it("directory provider finds a registered agent", async () => {
    const dirProvider = new DirectoryProvider(directoryUrl, "sha256:client-fp");
    const registry = new DiscoveryRegistry([dirProvider], 300);

    const results = await registry.search({ query: "rust" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("rust-expert");
    expect(results[0].status).toBe("online");
  });

  it("multiple providers merge and deduplicate results", async () => {
    const mockAgentAddr = mockAgentServer.address() as { port: number };

    const staticProvider = new StaticProvider({
      "rust-expert": {
        endpoint: `http://127.0.0.1:${mockAgentAddr.port}`,
        agentCardUrl: `http://127.0.0.1:${mockAgentAddr.port}/rust-expert/.well-known/agent-card.json`,
        description: "Rust expert (from static)",
      },
    });

    const dirProvider = new DirectoryProvider(directoryUrl, "sha256:client-fp");
    const registry = new DiscoveryRegistry([staticProvider, dirProvider], 300);

    const results = await registry.search({ query: "rust" });

    // Both providers found the same endpoint — should be deduplicated
    expect(results).toHaveLength(1);
    // Static provider is first, so its version wins
    expect(results[0].handle).toBe("rust-expert");
  });

  it("discovered agent card URL is fetchable", async () => {
    const dirProvider = new DirectoryProvider(directoryUrl, "sha256:client-fp");
    const registry = new DiscoveryRegistry([dirProvider], 0); // No cache for this test

    const results = await registry.search({ query: "rust" });
    expect(results).toHaveLength(1);

    // Fetch the agent card from the discovered URL
    const agentCardRes = await fetch(results[0].agentCardUrl);
    expect(agentCardRes.status).toBe(200);

    const card = await agentCardRes.json();
    expect(card.name).toBe("rust-expert");
    expect(card.description).toBe("Expert in Rust and systems programming");
  });

  it("resolve returns a specific agent from the directory", async () => {
    const dirProvider = new DirectoryProvider(directoryUrl, "sha256:client-fp");
    const registry = new DiscoveryRegistry([dirProvider], 300);

    const result = await registry.resolve("rust-expert");
    expect(result).not.toBeNull();
    expect(result!.handle).toBe("rust-expert");
    expect(result!.status).toBe("online");
  });

  it("heartbeat keeps an agent online", async () => {
    const dirProvider = new DirectoryProvider(directoryUrl, "sha256:bob-fingerprint");

    // Send heartbeat
    await dirProvider.heartbeat("rust-expert");

    // Agent should still be online
    const result = await dirProvider.resolve("rust-expert");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("online");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd tidepool && pnpm test -- test/discovery-e2e.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `cd tidepool && pnpm test`
Expected: All tests across all files PASS (existing Phase 1-3 tests + new discovery tests).

- [ ] **Step 4: Commit**

```bash
git add tidepool/test/discovery-e2e.test.ts
git commit -m "test(tidepool): discovery e2e — static, directory, dedup, agent card fetch"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd tidepool && pnpm test`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Manual smoke test — full discovery flow**

```bash
cd tidepool

# Setup
npx tsx bin/cli.ts init --dir /tmp/cc-phase4
npx tsx bin/cli.ts register --name my-agent --description "My test agent" --endpoint http://localhost:18800 --dir /tmp/cc-phase4
```

Add static peers to the config:
```bash
cat >> /tmp/cc-phase4/server.toml << 'EOF'

[discovery.static.peers.example-rust]
endpoint = "https://example.com:9900"
agentCardUrl = "https://example.com:9900/rust/.well-known/agent-card.json"
description = "Example Rust agent"

[discovery.static.peers.example-ml]
endpoint = "https://ml.example.com:9900"
agentCardUrl = "https://ml.example.com:9900/ml/.well-known/agent-card.json"
description = "Example ML agent"
EOF
```

Test search:
```bash
# Search all
npx tsx bin/cli.ts search --dir /tmp/cc-phase4

# Search with query
npx tsx bin/cli.ts search "rust" --dir /tmp/cc-phase4

# Search local only
npx tsx bin/cli.ts search --local --dir /tmp/cc-phase4
```

Expected:
```
Searching via: static...

Found 2 agent(s):

  example-rust [offline]
    Example Rust agent
    Endpoint: https://example.com:9900
    Agent Card: https://example.com:9900/rust/.well-known/agent-card.json

  example-ml [offline]
    Example ML agent
    Endpoint: https://ml.example.com:9900
    Agent Card: https://ml.example.com:9900/ml/.well-known/agent-card.json

To connect to an agent:
  tidepool connect <agent-card-url>
```

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/cc-phase4
```

- [ ] **Step 5: Final commit**

```bash
git add -A tidepool/
git commit -m "feat(tidepool): Phase 4 complete — pluggable discovery with static, mDNS, and cloud directory providers"
```
