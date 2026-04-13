# Claw Connect Phase 3: Rate Limiting and Error Handling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server and agent rate limits protect the machine and each agent's compute. Proper A2A error responses for all failure modes. Timeout enforcement on the proxy kills slow agent responses.

**Architecture:** Phase 3 adds two in-memory token bucket rate limiters (server-global and per-agent) to the middleware pipeline from Phase 1, inserts them at the correct positions in the request flow, upgrades raw HTTP error responses to proper A2A task responses, and adds configurable timeout enforcement on the proxy's fetch to local agents.

**Tech Stack:** Same as Phase 1 — Node.js, TypeScript, Express, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-13-claw-connect-revised-design.md`

**Depends on:** Phase 1 (server, middleware, proxy, types) and Phase 2 (friends, handshake)

---

## File Structure

```
claw-connect/
├── src/
│   ├── rate-limiter.ts           # NEW — Token bucket implementation
│   ├── errors.ts                 # NEW — A2A error response builders
│   ├── types.ts                  # MODIFIED — add timeoutSeconds to AgentConfig
│   ├── middleware.ts              # MODIFIED — add checkServerRateLimit, checkAgentRateLimit
│   └── server.ts                 # MODIFIED — wire rate limiters + timeout + A2A error responses
├── test/
│   ├── rate-limiter.test.ts      # NEW — Token bucket unit tests
│   ├── errors.test.ts            # NEW — Error response builder tests
│   ├── middleware.test.ts         # MODIFIED — add rate limit middleware tests
│   └── e2e-rate-limit.test.ts    # NEW — End-to-end rate limit + timeout tests
└── fixtures/
    └── server.toml               # MODIFIED — add timeoutSeconds field
```

---

### Task 1: Token Bucket Rate Limiter

**Files:**
- Create: `claw-connect/src/rate-limiter.ts`
- Create: `claw-connect/test/rate-limiter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `claw-connect/test/rate-limiter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenBucket, parseRateLimit } from "../src/rate-limiter.js";

describe("parseRateLimit", () => {
  it("parses 'N/hour' format", () => {
    const result = parseRateLimit("100/hour");
    expect(result).toEqual({ tokens: 100, windowMs: 3_600_000 });
  });

  it("parses '50/hour' format", () => {
    const result = parseRateLimit("50/hour");
    expect(result).toEqual({ tokens: 50, windowMs: 3_600_000 });
  });

  it("parses '10/minute' format", () => {
    const result = parseRateLimit("10/minute");
    expect(result).toEqual({ tokens: 10, windowMs: 60_000 });
  });

  it("throws on invalid format", () => {
    expect(() => parseRateLimit("bad")).toThrow();
    expect(() => parseRateLimit("100/year")).toThrow();
    expect(() => parseRateLimit("0/hour")).toThrow();
  });
});

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests within the limit", () => {
    const bucket = new TokenBucket(5, 3_600_000);

    for (let i = 0; i < 5; i++) {
      const result = bucket.consume();
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects requests over the limit", () => {
    const bucket = new TokenBucket(3, 3_600_000);

    bucket.consume();
    bucket.consume();
    bucket.consume();

    const result = bucket.consume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("refills tokens over time", () => {
    const bucket = new TokenBucket(2, 60_000); // 2 per minute

    // Consume all
    bucket.consume();
    bucket.consume();
    expect(bucket.consume().allowed).toBe(false);

    // Advance 30 seconds — should refill 1 token (half the window)
    vi.advanceTimersByTime(30_000);

    const result = bucket.consume();
    expect(result.allowed).toBe(true);
  });

  it("never exceeds max tokens after long idle", () => {
    const bucket = new TokenBucket(5, 60_000);

    // Consume 2
    bucket.consume();
    bucket.consume();

    // Advance way past the window
    vi.advanceTimersByTime(600_000);

    // Should have at most 5 tokens, not more
    for (let i = 0; i < 5; i++) {
      expect(bucket.consume().allowed).toBe(true);
    }
    expect(bucket.consume().allowed).toBe(false);
  });

  it("returns correct retryAfterSeconds", () => {
    const bucket = new TokenBucket(10, 3_600_000); // 10/hour

    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      bucket.consume();
    }

    const result = bucket.consume();
    expect(result.allowed).toBe(false);
    // 1 token refills every 360 seconds (3600/10)
    expect(result.retryAfterSeconds).toBe(360);
  });

  it("reports remaining tokens", () => {
    const bucket = new TokenBucket(5, 60_000);

    expect(bucket.remaining()).toBe(5);
    bucket.consume();
    expect(bucket.remaining()).toBe(4);
    bucket.consume();
    bucket.consume();
    expect(bucket.remaining()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/rate-limiter.test.ts`
Expected: FAIL — `Cannot find module '../src/rate-limiter.js'`

- [ ] **Step 3: Write the implementation**

Create `claw-connect/src/rate-limiter.ts`:

```typescript
export interface RateLimitConfig {
  tokens: number;
  windowMs: number;
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const VALID_UNITS: Record<string, number> = {
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
};

export function parseRateLimit(rateLimit: string): RateLimitConfig {
  const match = rateLimit.match(/^(\d+)\/(hour|minute|second)$/);
  if (!match) {
    throw new Error(
      `Invalid rate limit format: "${rateLimit}". Expected "N/hour", "N/minute", or "N/second".`,
    );
  }

  const tokens = parseInt(match[1], 10);
  if (tokens <= 0) {
    throw new Error(`Rate limit tokens must be positive, got ${tokens}`);
  }

  const windowMs = VALID_UNITS[match[2]];
  return { tokens, windowMs };
}

/**
 * Simple token bucket rate limiter.
 *
 * In-memory, resets on server restart. Not a security boundary —
 * just a courtesy mechanism to protect the machine and agent compute.
 *
 * Tokens refill continuously (not in bursts). The refill rate is
 * maxTokens / windowMs, so a "10/hour" bucket refills 1 token every
 * 360 seconds.
 */
export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly windowMs: number;
  private lastRefill: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  consume(): ConsumeResult {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // How long until 1 token refills?
    const msPerToken = this.windowMs / this.maxTokens;
    const retryAfterSeconds = Math.ceil(msPerToken / 1000);

    return { allowed: false, retryAfterSeconds };
  }

  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillRate = this.maxTokens / this.windowMs; // tokens per ms
    const newTokens = elapsed * refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/rate-limiter.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add claw-connect/src/rate-limiter.ts claw-connect/test/rate-limiter.test.ts
git commit -m "feat(claw-connect): token bucket rate limiter with continuous refill"
```

---

### Task 2: A2A Error Response Builders

**Files:**
- Create: `claw-connect/src/errors.ts`
- Create: `claw-connect/test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `claw-connect/test/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
} from "../src/errors.js";

describe("rateLimitResponse", () => {
  it("returns a 429-shaped A2A error with retryAfterSeconds", () => {
    const resp = rateLimitResponse(360);

    expect(resp.statusCode).toBe(429);
    expect(resp.headers["Retry-After"]).toBe("360");
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
    expect(resp.body.artifacts[0].parts[0].text).toContain("Rate limit");
  });
});

describe("notFriendResponse", () => {
  it("returns TASK_STATE_REJECTED for non-friends", () => {
    const resp = notFriendResponse();

    expect(resp.statusCode).toBe(403);
    expect(resp.body.status.state).toBe("TASK_STATE_REJECTED");
    expect(resp.body.artifacts[0].parts[0].text).toContain(
      "not authorized",
    );
  });
});

describe("agentNotFoundResponse", () => {
  it("returns 404 with TASK_STATE_FAILED", () => {
    const resp = agentNotFoundResponse("unknown-agent");

    expect(resp.statusCode).toBe(404);
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
    expect(resp.body.artifacts[0].parts[0].text).toContain("unknown-agent");
  });
});

describe("agentScopeDeniedResponse", () => {
  it("returns 403 with TASK_STATE_REJECTED", () => {
    const resp = agentScopeDeniedResponse("rust-expert");

    expect(resp.statusCode).toBe(403);
    expect(resp.body.status.state).toBe("TASK_STATE_REJECTED");
    expect(resp.body.artifacts[0].parts[0].text).toContain("rust-expert");
  });
});

describe("agentTimeoutResponse", () => {
  it("returns TASK_STATE_FAILED with timeout message", () => {
    const resp = agentTimeoutResponse("rust-expert", 30);

    expect(resp.statusCode).toBe(504);
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
    expect(resp.body.artifacts[0].parts[0].text).toContain("rust-expert");
    expect(resp.body.artifacts[0].parts[0].text).toContain("30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/errors.test.ts`
Expected: FAIL — `Cannot find module '../src/errors.js'`

- [ ] **Step 3: Write the implementation**

Create `claw-connect/src/errors.ts`:

```typescript
import { v4 as uuidv4 } from "uuid";

export interface A2AErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: {
    id: string;
    status: { state: string };
    artifacts: Array<{
      artifactId: string;
      parts: Array<{ kind: string; text: string }>;
    }>;
  };
}

function buildErrorResponse(
  statusCode: number,
  state: string,
  message: string,
  headers: Record<string, string> = {},
): A2AErrorResponse {
  return {
    statusCode,
    headers,
    body: {
      id: uuidv4(),
      status: { state },
      artifacts: [
        {
          artifactId: "error",
          parts: [{ kind: "text", text: message }],
        },
      ],
    },
  };
}

/**
 * 429 Too Many Requests — server or agent rate limit hit.
 */
export function rateLimitResponse(
  retryAfterSeconds: number,
): A2AErrorResponse {
  return buildErrorResponse(
    429,
    "TASK_STATE_FAILED",
    `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/**
 * 403 — peer's cert fingerprint is not in friends.toml.
 * Uses TASK_STATE_REJECTED (not a transient error — they need to send
 * a CONNECTION_REQUEST first).
 */
export function notFriendResponse(): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "TASK_STATE_REJECTED",
    "You are not authorized. Send a CONNECTION_REQUEST to establish a friendship first.",
  );
}

/**
 * 404 — addressed tenant does not exist on this server.
 */
export function agentNotFoundResponse(tenant: string): A2AErrorResponse {
  return buildErrorResponse(
    404,
    "TASK_STATE_FAILED",
    `Agent "${tenant}" not found on this server.`,
  );
}

/**
 * 403 — friend exists but is scoped and this agent is not in their list.
 */
export function agentScopeDeniedResponse(tenant: string): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "TASK_STATE_REJECTED",
    `You are not authorized to access agent "${tenant}".`,
  );
}

/**
 * 504 — agent did not respond within timeout_seconds.
 */
export function agentTimeoutResponse(
  tenant: string,
  timeoutSeconds: number,
): A2AErrorResponse {
  return buildErrorResponse(
    504,
    "TASK_STATE_FAILED",
    `Agent "${tenant}" did not respond within ${timeoutSeconds} seconds.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/errors.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add claw-connect/src/errors.ts claw-connect/test/errors.test.ts
git commit -m "feat(claw-connect): A2A error response builders for all failure modes"
```

---

### Task 3: Add timeoutSeconds to Types and Config

**Files:**
- Modify: `claw-connect/src/types.ts`
- Modify: `claw-connect/src/config.ts`
- Modify: `claw-connect/fixtures/server.toml`
- Modify: `claw-connect/test/config.test.ts`

- [ ] **Step 1: Update types.ts — add timeoutSeconds to AgentConfig**

Edit `claw-connect/src/types.ts` — change the `AgentConfig` interface:

```typescript
// BEFORE:
export interface AgentConfig {
  localEndpoint: string;
  rateLimit: string;
  description: string;
}

// AFTER:
export interface AgentConfig {
  localEndpoint: string;
  rateLimit: string;
  description: string;
  timeoutSeconds: number;
}
```

- [ ] **Step 2: Update fixtures/server.toml — add timeoutSeconds**

Edit `claw-connect/fixtures/server.toml`:

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
timeoutSeconds = 30

[agents.code-reviewer]
localEndpoint = "http://localhost:18801"
rateLimit = "30/hour"
description = "Code review and best practices"
timeoutSeconds = 60

[connectionRequests]
mode = "deny"

[discovery]
providers = ["static"]
cacheTtlSeconds = 300
```

- [ ] **Step 3: Update config.ts — parse timeoutSeconds with default**

Edit `claw-connect/src/config.ts` — in the `loadServerConfig` function, update the agents mapping:

```typescript
// BEFORE:
agents: Object.fromEntries(
  Object.entries(agents).map(([name, cfg]) => [
    name,
    {
      localEndpoint: cfg.localEndpoint as string,
      rateLimit: (cfg.rateLimit as string) ?? "50/hour",
      description: (cfg.description as string) ?? "",
    },
  ]),
),

// AFTER:
agents: Object.fromEntries(
  Object.entries(agents).map(([name, cfg]) => [
    name,
    {
      localEndpoint: cfg.localEndpoint as string,
      rateLimit: (cfg.rateLimit as string) ?? "50/hour",
      description: (cfg.description as string) ?? "",
      timeoutSeconds: (cfg.timeoutSeconds as number) ?? 30,
    },
  ]),
),
```

- [ ] **Step 4: Update config.test.ts — verify timeoutSeconds**

Edit `claw-connect/test/config.test.ts` — add assertions to the existing `loadServerConfig` test:

```typescript
// ADD inside the "loads and parses server.toml" test, after the existing assertions:
    expect(config.agents["rust-expert"].timeoutSeconds).toBe(30);
    expect(config.agents["code-reviewer"].timeoutSeconds).toBe(60);
```

- [ ] **Step 5: Run tests to verify**

Run: `cd claw-connect && pnpm test -- test/config.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Run typecheck**

Run: `cd claw-connect && pnpm typecheck`
Expected: May fail if other files reference `AgentConfig` without providing `timeoutSeconds`. Fix any type errors by adding the field where `AgentConfig` objects are constructed (test fixtures, e2e setup, etc.). Every place that constructs an `AgentConfig` inline needs `timeoutSeconds`:

In `claw-connect/test/middleware.test.ts`, update the agent config:

```typescript
// BEFORE:
"rust-expert": {
  localEndpoint: "http://localhost:18800",
  rateLimit: "50/hour",
  description: "Rust expert",
},

// AFTER:
"rust-expert": {
  localEndpoint: "http://localhost:18800",
  rateLimit: "50/hour",
  description: "Rust expert",
  timeoutSeconds: 30,
},
```

In `claw-connect/test/e2e.test.ts`, update both Alice's and Bob's agent configs:

```typescript
// BEFORE (Alice):
"alice-dev": {
  localEndpoint: "http://127.0.0.1:28800",
  rateLimit: "50/hour",
  description: "Alice's dev agent",
},

// AFTER (Alice):
"alice-dev": {
  localEndpoint: "http://127.0.0.1:28800",
  rateLimit: "50/hour",
  description: "Alice's dev agent",
  timeoutSeconds: 30,
},

// BEFORE (Bob):
"rust-expert": {
  localEndpoint: "http://127.0.0.1:38800",
  rateLimit: "50/hour",
  description: "Bob's Rust expert",
},

// AFTER (Bob):
"rust-expert": {
  localEndpoint: "http://127.0.0.1:38800",
  rateLimit: "50/hour",
  description: "Bob's Rust expert",
  timeoutSeconds: 30,
},
```

In `claw-connect/bin/cli.ts`, update the register command where it writes agent config:

```typescript
// BEFORE:
(config.agents as Record<string, unknown>)[opts.name] = {
  localEndpoint: opts.endpoint,
  rateLimit: "50/hour",
  description: opts.description,
};

// AFTER:
(config.agents as Record<string, unknown>)[opts.name] = {
  localEndpoint: opts.endpoint,
  rateLimit: "50/hour",
  description: opts.description,
  timeoutSeconds: 30,
};
```

- [ ] **Step 7: Re-run typecheck and full test suite**

Run: `cd claw-connect && pnpm typecheck && pnpm test`
Expected: No type errors. All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add claw-connect/src/types.ts claw-connect/src/config.ts claw-connect/fixtures/server.toml claw-connect/test/config.test.ts claw-connect/test/middleware.test.ts claw-connect/test/e2e.test.ts claw-connect/bin/cli.ts
git commit -m "feat(claw-connect): add timeoutSeconds to AgentConfig with 30s default"
```

---

### Task 4: Wire Rate Limiters into Middleware

**Files:**
- Modify: `claw-connect/src/middleware.ts`
- Modify: `claw-connect/test/middleware.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `claw-connect/test/middleware.test.ts`:

```typescript
import {
  checkFriend,
  checkAgentScope,
  resolveTenant,
  createRateLimitChecker,
} from "../src/middleware.js";
import { TokenBucket } from "../src/rate-limiter.js";

// ... existing tests stay unchanged ...

describe("createRateLimitChecker", () => {
  it("returns allowed when bucket has tokens", () => {
    const bucket = new TokenBucket(10, 3_600_000);
    const check = createRateLimitChecker(bucket);

    const result = check();
    expect(result.allowed).toBe(true);
  });

  it("returns denied with retryAfterSeconds when bucket is empty", () => {
    const bucket = new TokenBucket(1, 3_600_000);
    const check = createRateLimitChecker(bucket);

    // Consume the only token
    check();

    const result = check();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/middleware.test.ts`
Expected: FAIL — `createRateLimitChecker` is not exported from middleware.

- [ ] **Step 3: Update middleware.ts — add rate limit checker**

Edit `claw-connect/src/middleware.ts` — add the import and new function:

```typescript
// ADD at the top:
import type { ConsumeResult } from "./rate-limiter.js";
import { TokenBucket } from "./rate-limiter.js";

// ... existing functions stay unchanged ...

// ADD at the bottom:

/**
 * Creates a rate limit check function bound to a token bucket.
 * Returns a function that consumes one token and reports whether
 * the request is allowed.
 */
export function createRateLimitChecker(
  bucket: TokenBucket,
): () => ConsumeResult {
  return () => bucket.consume();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/middleware.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add claw-connect/src/middleware.ts claw-connect/test/middleware.test.ts
git commit -m "feat(claw-connect): rate limit checker in middleware pipeline"
```

---

### Task 5: Wire Everything into server.ts

**Files:**
- Modify: `claw-connect/src/server.ts`

This task modifies the `createPublicApp` function to implement the full middleware pipeline from the spec:

```
Inbound A2A request over mTLS
  → Server rate limit ok?                No → 429 with Retry-After
  → Cert fingerprint in friends.toml?    No → CONNECTION_REQUEST? → handshake handler
                                              Otherwise → TASK_STATE_REJECTED
  → Which tenant (agent) addressed?      Unknown → 404
  → Agent rate limit ok?                 No → 429 with Retry-After
  → Friend scoped to specific agents?    Yes + agent not in list → 403
  → Forward A2A to agent's local_endpoint (with timeout enforcement)
```

- [ ] **Step 1: Update imports in server.ts**

Edit `claw-connect/src/server.ts` — add imports at the top:

```typescript
// ADD these imports:
import { TokenBucket, parseRateLimit } from "./rate-limiter.js";
import { createRateLimitChecker } from "./middleware.js";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
  type A2AErrorResponse,
} from "./errors.js";
```

- [ ] **Step 2: Add helper to send A2A error responses**

Add this helper function in `claw-connect/src/server.ts`, before `createPublicApp`:

```typescript
function sendA2AError(res: express.Response, error: A2AErrorResponse): void {
  for (const [key, value] of Object.entries(error.headers)) {
    res.setHeader(key, value);
  }
  res.status(error.statusCode).json(error.body);
}
```

- [ ] **Step 3: Initialize rate limiter buckets in startServer**

Edit `claw-connect/src/server.ts` — in the `startServer` function, after loading config and before creating the apps, add rate limiter initialization:

```typescript
// ADD after: const remoteAgents = opts.remoteAgents ?? [];

// Initialize rate limiters
const serverRateConfig = parseRateLimit(serverConfig.server.rateLimit);
const serverBucket = new TokenBucket(
  serverRateConfig.tokens,
  serverRateConfig.windowMs,
);

const agentBuckets = new Map<string, TokenBucket>();
for (const [name, agentConfig] of Object.entries(serverConfig.agents)) {
  const agentRateConfig = parseRateLimit(agentConfig.rateLimit);
  agentBuckets.set(
    name,
    new TokenBucket(agentRateConfig.tokens, agentRateConfig.windowMs),
  );
}
```

- [ ] **Step 4: Update createPublicApp signature to accept rate limiter state**

Edit `claw-connect/src/server.ts`:

```typescript
// BEFORE:
function createPublicApp(
  config: ServerConfig,
  friends: FriendsConfig,
  configDir: string,
): express.Application {

// AFTER:
function createPublicApp(
  config: ServerConfig,
  friends: FriendsConfig,
  configDir: string,
  serverBucket: TokenBucket,
  agentBuckets: Map<string, TokenBucket>,
): express.Application {
```

Update the call site in `startServer`:

```typescript
// BEFORE:
const publicApp = createPublicApp(serverConfig, friendsConfig, opts.configDir);

// AFTER:
const publicApp = createPublicApp(
  serverConfig,
  friendsConfig,
  opts.configDir,
  serverBucket,
  agentBuckets,
);
```

- [ ] **Step 5: Rewrite the public A2A proxy route with the full middleware pipeline**

Edit `claw-connect/src/server.ts` — replace the existing `app.post("/:tenant/*", ...)` handler inside `createPublicApp` with:

```typescript
  // A2A proxy endpoint per tenant — full middleware pipeline
  app.post(
    "/:tenant/*",
    async (req, res) => {
      const { tenant } = req.params;

      // --- Step 1: Server rate limit ---
      const serverCheck = createRateLimitChecker(serverBucket);
      const serverResult = serverCheck();
      if (!serverResult.allowed) {
        sendA2AError(res, rateLimitResponse(serverResult.retryAfterSeconds));
        return;
      }

      // --- Step 2: Extract peer cert fingerprint ---
      const peerCert = (req.socket as any).getPeerCertificate?.();
      if (!peerCert || !peerCert.raw) {
        sendA2AError(res, notFriendResponse());
        return;
      }

      const peerFingerprint = getFingerprint(
        `-----BEGIN CERTIFICATE-----\n${peerCert.raw.toString("base64")}\n-----END CERTIFICATE-----`,
      );

      // --- Step 3: Check friends list ---
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        // Phase 2 added CONNECTION_REQUEST handling here.
        // For non-connection-request messages from non-friends:
        // Check if this is a CONNECTION_REQUEST (Phase 2 handler)
        const messageText = req.body?.message?.parts?.[0]?.text;
        if (messageText === "CONNECTION_REQUEST") {
          // Delegate to connection request handler (Phase 2)
          // This path is handled by the connection request middleware
          // added in Phase 2. If Phase 2 is not yet implemented,
          // fall through to rejection.
        }

        sendA2AError(res, notFriendResponse());
        return;
      }

      // --- Step 4: Resolve tenant ---
      const agent = resolveTenant(config, tenant);
      if (!agent) {
        sendA2AError(res, agentNotFoundResponse(tenant));
        return;
      }

      // --- Step 5: Agent rate limit ---
      const agentBucket = agentBuckets.get(tenant);
      if (agentBucket) {
        const agentCheck = createRateLimitChecker(agentBucket);
        const agentResult = agentCheck();
        if (!agentResult.allowed) {
          sendA2AError(res, rateLimitResponse(agentResult.retryAfterSeconds));
          return;
        }
      }

      // --- Step 6: Check agent scope ---
      if (!checkAgentScope(friendLookup.friend, tenant)) {
        sendA2AError(res, agentScopeDeniedResponse(tenant));
        return;
      }

      // --- Step 7: Forward to local agent with timeout ---
      const a2aPath = req.params[0] || "message:send";
      const targetUrl = `${agent.localEndpoint}/${a2aPath}`;
      const timeoutMs = agent.timeoutSeconds * 1000;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const data = await response.json();
        res.status(response.status).json(data);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          sendA2AError(res, agentTimeoutResponse(tenant, agent.timeoutSeconds));
        } else {
          sendA2AError(
            res,
            agentTimeoutResponse(tenant, agent.timeoutSeconds),
          );
        }
      }
    },
  );
```

- [ ] **Step 6: Run typecheck**

Run: `cd claw-connect && pnpm typecheck`
Expected: No errors. If there are issues, fix them before continuing.

- [ ] **Step 7: Commit**

```bash
git add claw-connect/src/server.ts
git commit -m "feat(claw-connect): full middleware pipeline with rate limits, A2A errors, and timeout"
```

---

### Task 6: End-to-End Rate Limit and Timeout Tests

**Files:**
- Create: `claw-connect/test/e2e-rate-limit.test.ts`

- [ ] **Step 1: Write the e2e tests**

Create `claw-connect/test/e2e-rate-limit.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import https from "https";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";

/**
 * Mock A2A agent — echo server.
 */
function createMockAgent(port: number, name: string): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "no message";
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} received: ${userMessage}` }],
        },
      ],
    });
  });

  return app.listen(port, "127.0.0.1");
}

/**
 * Mock A2A agent that never responds — for timeout testing.
 */
function createSlowAgent(port: number): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (_req, _res) => {
    // Never respond — hangs forever.
    // The proxy's timeout should kill this.
  });

  return app.listen(port, "127.0.0.1");
}

/**
 * Make an mTLS request to the public interface using a specific client cert.
 */
async function mTLSFetch(
  url: string,
  body: unknown,
  certPath: string,
  keyPath: string,
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(body);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: JSON.parse(data),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

const a2aMessage = (text: string) => ({
  message: {
    messageId: "test-msg",
    role: "ROLE_USER",
    parts: [{ kind: "text", text }],
  },
});

describe("e2e: rate limiting and timeout", () => {
  let tmpDir: string;
  let serverConfigDir: string;
  let peerConfigDir: string;
  let mockAgent: http.Server;
  let slowAgent: http.Server;
  let server: { close: () => void };
  let peerCertPath: string;
  let peerKeyPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-rl-"));

    // --- Server setup (the one being rate-limited) ---
    serverConfigDir = path.join(tmpDir, "server");
    fs.mkdirSync(path.join(serverConfigDir, "agents/fast-agent"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(serverConfigDir, "agents/slow-agent"), {
      recursive: true,
    });

    const serverIdentity = await generateIdentity({
      name: "fast-agent",
      certPath: path.join(
        serverConfigDir,
        "agents/fast-agent/identity.crt",
      ),
      keyPath: path.join(
        serverConfigDir,
        "agents/fast-agent/identity.key",
      ),
    });

    // Reuse cert for slow-agent (server just needs one for TLS)
    await generateIdentity({
      name: "slow-agent",
      certPath: path.join(
        serverConfigDir,
        "agents/slow-agent/identity.crt",
      ),
      keyPath: path.join(
        serverConfigDir,
        "agents/slow-agent/identity.key",
      ),
    });

    // --- Peer setup (the one sending requests) ---
    peerConfigDir = path.join(tmpDir, "peer");
    fs.mkdirSync(path.join(peerConfigDir, "agents/peer-agent"), {
      recursive: true,
    });

    const peerIdentity = await generateIdentity({
      name: "peer-agent",
      certPath: path.join(peerConfigDir, "agents/peer-agent/identity.crt"),
      keyPath: path.join(peerConfigDir, "agents/peer-agent/identity.key"),
    });

    peerCertPath = path.join(
      peerConfigDir,
      "agents/peer-agent/identity.crt",
    );
    peerKeyPath = path.join(
      peerConfigDir,
      "agents/peer-agent/identity.key",
    );

    // --- Server config ---
    // Server rate limit: 5/minute (low, easy to hit in tests)
    // fast-agent rate limit: 3/minute
    // slow-agent rate limit: 10/minute, timeout: 2 seconds
    fs.writeFileSync(
      path.join(serverConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 39900,
          host: "0.0.0.0",
          localPort: 39901,
          rateLimit: "5/minute",
        },
        agents: {
          "fast-agent": {
            localEndpoint: "http://127.0.0.1:48800",
            rateLimit: "3/minute",
            description: "Fast agent",
            timeoutSeconds: 30,
          },
          "slow-agent": {
            localEndpoint: "http://127.0.0.1:48801",
            rateLimit: "10/minute",
            description: "Slow agent",
            timeoutSeconds: 2,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Peer is a friend
    fs.writeFileSync(
      path.join(serverConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "peer-agent": { fingerprint: peerIdentity.fingerprint },
        },
      } as any),
    );

    // --- Start agents ---
    mockAgent = createMockAgent(48800, "fast-agent");
    slowAgent = createSlowAgent(48801);

    // --- Start server ---
    server = await startServer({
      configDir: serverConfigDir,
    });
  });

  afterAll(() => {
    mockAgent?.close();
    slowAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("allows requests within the agent rate limit", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:39900/fast-agent/message:send",
      a2aMessage("hello"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(200);
    expect(resp.body.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("returns 429 with Retry-After when agent rate limit is exceeded", async () => {
    // Drain the fast-agent bucket (3/minute).
    // The first test already consumed 1, so we need 2 more.
    await mTLSFetch(
      "https://127.0.0.1:39900/fast-agent/message:send",
      a2aMessage("msg 2"),
      peerCertPath,
      peerKeyPath,
    );
    await mTLSFetch(
      "https://127.0.0.1:39900/fast-agent/message:send",
      a2aMessage("msg 3"),
      peerCertPath,
      peerKeyPath,
    );

    // This should hit the agent rate limit
    const resp = await mTLSFetch(
      "https://127.0.0.1:39900/fast-agent/message:send",
      a2aMessage("msg 4"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(429);
    expect(resp.headers["retry-after"]).toBeDefined();
    expect(parseInt(resp.headers["retry-after"])).toBeGreaterThan(0);
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
  });

  it("returns TASK_STATE_FAILED with 504 when agent times out", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:39900/slow-agent/message:send",
      a2aMessage("this will timeout"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(504);
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
    expect(resp.body.artifacts[0].parts[0].text).toContain("slow-agent");
    expect(resp.body.artifacts[0].parts[0].text).toContain("2");
  }, 10_000); // Allow 10s for this test (agent timeout is 2s)

  it("returns TASK_STATE_REJECTED for non-friends", async () => {
    // Generate a cert that is NOT in friends.toml
    const strangerDir = path.join(tmpDir, "stranger");
    fs.mkdirSync(path.join(strangerDir, "agents/stranger"), {
      recursive: true,
    });

    await generateIdentity({
      name: "stranger",
      certPath: path.join(strangerDir, "agents/stranger/identity.crt"),
      keyPath: path.join(strangerDir, "agents/stranger/identity.key"),
    });

    const resp = await mTLSFetch(
      "https://127.0.0.1:39900/fast-agent/message:send",
      a2aMessage("let me in"),
      path.join(strangerDir, "agents/stranger/identity.crt"),
      path.join(strangerDir, "agents/stranger/identity.key"),
    );

    expect(resp.status).toBe(403);
    expect(resp.body.status.state).toBe("TASK_STATE_REJECTED");
  });

  it("returns 404 for unknown agent tenant", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:39900/nonexistent-agent/message:send",
      a2aMessage("hello?"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(404);
    expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
    expect(resp.body.artifacts[0].parts[0].text).toContain(
      "nonexistent-agent",
    );
  });

  it("returns 429 when server-global rate limit is exceeded", async () => {
    // The server limit is 5/minute. We've already used several tokens
    // across previous tests. Send enough to exhaust the server bucket.
    // Since the server bucket is shared across all agents, we target
    // slow-agent (which has a higher per-agent limit) to avoid hitting
    // the per-agent limit first.
    //
    // Note: previous tests consumed tokens from the server bucket.
    // We need to push it over 5 total.

    const results = [];
    for (let i = 0; i < 5; i++) {
      try {
        const resp = await mTLSFetch(
          "https://127.0.0.1:39900/slow-agent/message:send",
          a2aMessage(`flood ${i}`),
          peerCertPath,
          peerKeyPath,
        );
        results.push(resp);
      } catch {
        // Connection errors are fine — server might reject
      }
    }

    // At least one response should be a 429 from the server rate limit
    const has429 = results.some((r) => r.status === 429);
    expect(has429).toBe(true);
  }, 30_000); // Allow 30s — slow-agent timeouts add up
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd claw-connect && pnpm test -- test/e2e-rate-limit.test.ts`
Expected: All tests PASS.

If there are failures, common issues:
- **Port conflicts** — ensure ports 39900, 39901, 48800, 48801 are free.
- **Token counting** — tests run sequentially, and the server bucket is shared across all tests. The test for server-global rate limit sends extra requests to force the 429.
- **Timeout test too slow** — the slow-agent test has a 10s timeout allowance; the agent timeout is 2s, so there's plenty of headroom.

- [ ] **Step 3: Run the full test suite**

Run: `cd claw-connect && pnpm test`
Expected: All tests PASS (existing Phase 1 tests + new Phase 3 tests).

- [ ] **Step 4: Commit**

```bash
git add claw-connect/test/e2e-rate-limit.test.ts
git commit -m "test(claw-connect): e2e tests for rate limits, timeout, and A2A error responses"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd claw-connect && pnpm test`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd claw-connect && pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Verify the middleware pipeline matches the spec**

Review `claw-connect/src/server.ts` and confirm the `createPublicApp` handler follows this exact order:

1. Server rate limit check → 429 with Retry-After
2. Extract peer cert → TASK_STATE_REJECTED if missing
3. Check friends list → TASK_STATE_REJECTED if not a friend
4. Resolve tenant → 404 TASK_STATE_FAILED if agent not found
5. Agent rate limit check → 429 with Retry-After
6. Check agent scope → 403 TASK_STATE_REJECTED if scoped out
7. Forward to local agent with AbortController timeout → 504 TASK_STATE_FAILED on timeout

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A claw-connect/
git commit -m "feat(claw-connect): Phase 3 complete — rate limiting, timeout, and A2A error handling"
```
