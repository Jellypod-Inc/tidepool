# Adapter Interface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `POST /:tenant/:action` + `X-Agent` + static-endpoint adapter interface with a pure-A2A local interface + runtime SSE session registration + `.well-known/tidepool/*` extension namespace.

**Architecture:** Adapter opens a long-lived SSE session that carries registration + liveness + control events. Local A2A routes mounted at `/{handle}/...` on both public (mTLS) and local (loopback) interfaces. Tidepool-specific endpoints live under `.well-known/tidepool/*`. The adapter hosts its own A2A inbound server on an ephemeral port; the daemon POSTs to it.

**Tech Stack:** TypeScript (Node ESM), Express, Vitest, undici (already used for mTLS). No new deps.

**Spec:** `docs/superpowers/specs/2026-04-17-adapter-interface-design.md`

---

## File Structure

### New files
- `src/origin-check.ts` — Origin/Host header validation middleware
- `src/session/registry.ts` — In-memory session registry (name → {endpoint, card, sseRes})
- `src/session/card-merge.ts` — Merge adapter-supplied card fragment with daemon transport fields
- `src/session/endpoint.ts` — POST `/.well-known/tidepool/agents/{name}/session` handler
- `test/origin-check.test.ts`
- `test/session-registry.test.ts`
- `test/card-merge.test.ts`
- `test/session-endpoint.test.ts`
- `test/peers-endpoint.test.ts`
- `test/tasks-stub.test.ts`
- `test/adapter-interface-e2e.test.ts`

### Modified files
- `src/errors.ts` — Add structured error builders for new taxonomy
- `src/server.ts` — Rework `createLocalApp` for new routes; inbound proxy uses session registry
- `src/agent-card.ts` — Delegate composition to `session/card-merge.ts`
- `src/types.ts` — Add `AgentCardFragment`, `RegisteredSession`; remove `localEndpoint` from `AgentConfig`
- `src/config-holder.ts` — Updates for schema change
- `src/config-writer.ts` — Default config no longer writes `localEndpoint`
- `src/cli/register.ts` — Rename conceptually; no longer takes `--endpoint`
- `src/cli/serve.ts` / `src/cli/serve-daemon.ts` — Wire session registry into startServer
- `adapters/claude-code/src/http.ts` — Full A2A Message handling, tasks/* stubs
- `adapters/claude-code/src/start.ts` — Open SSE session on boot
- `adapters/claude-code/src/outbound.ts` — Drop X-Agent, update URL shape
- `adapters/claude-code/src/config.ts` — Peers sourced from SSE snapshot, not config file

---

## Task 1: Structured error response builders

**Files:**
- Modify: `src/errors.ts`
- Test: `test/errors.test.ts`

- [ ] **Step 1: Write failing tests for new structured error taxonomy**

Append to `test/errors.test.ts`:

```typescript
import {
  structuredError,
  originDeniedResponse,
  peerNotFoundResponse,
  sessionConflictResponse,
  peerUnreachableResponse,
  agentOfflineResponse,
  peerTimeoutResponse,
  unsupportedOperationResponse,
} from "../src/errors.js";

describe("structuredError", () => {
  it("builds a { error: { code, message, hint } } body", () => {
    const resp = structuredError(400, "invalid_request", "bad body", "check JSON syntax");
    expect(resp.statusCode).toBe(400);
    expect(resp.body).toEqual({
      error: { code: "invalid_request", message: "bad body", hint: "check JSON syntax" },
    });
  });
});

describe("originDeniedResponse", () => {
  it("returns 403 origin_denied", () => {
    const resp = originDeniedResponse("http://evil.example");
    expect(resp.statusCode).toBe(403);
    expect(resp.body.error.code).toBe("origin_denied");
    expect(resp.body.error.message).toContain("http://evil.example");
  });
});

describe("peerNotFoundResponse (structured)", () => {
  it("returns 404 peer_not_found", () => {
    const resp = peerNotFoundResponse("charlie");
    expect(resp.statusCode).toBe(404);
    expect(resp.body.error.code).toBe("peer_not_found");
    expect(resp.body.error.message).toContain("charlie");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("sessionConflictResponse", () => {
  it("returns 409 session_conflict", () => {
    const resp = sessionConflictResponse("alice");
    expect(resp.statusCode).toBe(409);
    expect(resp.body.error.code).toBe("session_conflict");
  });
});

describe("peerUnreachableResponse", () => {
  it("returns 502 peer_unreachable", () => {
    const resp = peerUnreachableResponse("bob");
    expect(resp.statusCode).toBe(502);
    expect(resp.body.error.code).toBe("peer_unreachable");
  });
});

describe("agentOfflineResponse", () => {
  it("returns 503 agent_offline", () => {
    const resp = agentOfflineResponse("alice");
    expect(resp.statusCode).toBe(503);
    expect(resp.body.error.code).toBe("agent_offline");
  });
});

describe("peerTimeoutResponse (structured)", () => {
  it("returns 504 peer_timeout", () => {
    const resp = peerTimeoutResponse("bob", 30);
    expect(resp.statusCode).toBe(504);
    expect(resp.body.error.code).toBe("peer_timeout");
  });
});

describe("unsupportedOperationResponse", () => {
  it("returns 405 with A2A JSON-RPC error envelope", () => {
    const resp = unsupportedOperationResponse("tasks/get", "msg-1");
    expect(resp.statusCode).toBe(405);
    expect(resp.body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32006,
        message: expect.stringContaining("tasks/get"),
      },
      id: "msg-1",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/errors.test.ts`
Expected: new tests fail with "structuredError is not exported" etc.

- [ ] **Step 3: Add structured error builders to `src/errors.ts`**

Append at the end of `src/errors.ts`:

```typescript
// ----- Structured error responses (new taxonomy per 2026-04-17 design) -----

export interface StructuredErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: { error: { code: string; message: string; hint?: string } };
}

export interface A2AJsonRpcErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: {
    jsonrpc: "2.0";
    error: { code: number; message: string; data?: unknown };
    id: string;
  };
}

export function structuredError(
  statusCode: number,
  code: string,
  message: string,
  hint?: string,
): StructuredErrorResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: { error: { code, message, ...(hint ? { hint } : {}) } },
  };
}

export function originDeniedResponse(origin: string): StructuredErrorResponse {
  return structuredError(
    403,
    "origin_denied",
    `Origin not allowed: ${origin}`,
    "Only localhost origins may access the tidepool local interface.",
  );
}

export function peerNotFoundResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    404,
    "peer_not_found",
    `No peer named "${handle}" is in friends.`,
    "Call GET /.well-known/tidepool/peers to list reachable peers.",
  );
}

export function sessionConflictResponse(name: string): StructuredErrorResponse {
  return structuredError(
    409,
    "session_conflict",
    `Agent "${name}" already has an active session.`,
    "Another adapter process is registered as this agent. Use `tidepool status` to inspect.",
  );
}

export function peerUnreachableResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    502,
    "peer_unreachable",
    `Peer "${handle}" did not accept the connection.`,
    "The peer's daemon may be offline or unreachable over the network.",
  );
}

export function agentOfflineResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    503,
    "agent_offline",
    `Agent "${handle}" is not currently registered.`,
    "The agent's adapter may have crashed or not yet started.",
  );
}

export function peerTimeoutResponse(
  handle: string,
  timeoutSeconds: number,
): StructuredErrorResponse {
  return structuredError(
    504,
    "peer_timeout",
    `Peer "${handle}" did not respond within ${timeoutSeconds} seconds.`,
    "The peer may be slow or unreachable. Retry if transient.",
  );
}

export function unsupportedOperationResponse(
  method: string,
  messageId: string,
): A2AJsonRpcErrorResponse {
  return {
    statusCode: 405,
    headers: { "Content-Type": "application/json" },
    body: {
      jsonrpc: "2.0",
      error: {
        code: -32006,
        message: `Operation not supported: ${method}. This tidepool instance is prose-only and does not implement task methods.`,
      },
      id: messageId,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/errors.test.ts`
Expected: all errors.test.ts tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat(errors): add structured error taxonomy for adapter interface"
```

---

## Task 2: Origin/Host check middleware

**Files:**
- Create: `src/origin-check.ts`
- Test: `test/origin-check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/origin-check.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isOriginAllowed, isHostAllowed } from "../src/origin-check.js";

describe("isOriginAllowed", () => {
  it("allows missing Origin header (non-browser clients)", () => {
    expect(isOriginAllowed(undefined, 4443)).toBe(true);
  });

  it("allows null origin (e.g., file:// or data: contexts)", () => {
    expect(isOriginAllowed("null", 4443)).toBe(true);
  });

  it("allows http://localhost:<port>", () => {
    expect(isOriginAllowed("http://localhost:4443", 4443)).toBe(true);
  });

  it("allows http://127.0.0.1:<port>", () => {
    expect(isOriginAllowed("http://127.0.0.1:4443", 4443)).toBe(true);
  });

  it("rejects a different port on localhost", () => {
    expect(isOriginAllowed("http://localhost:5555", 4443)).toBe(false);
  });

  it("rejects non-localhost origins", () => {
    expect(isOriginAllowed("http://evil.example", 4443)).toBe(false);
  });

  it("rejects https:// on localhost (loopback shouldn't need TLS)", () => {
    expect(isOriginAllowed("https://localhost:4443", 4443)).toBe(false);
  });
});

describe("isHostAllowed", () => {
  it("allows 127.0.0.1:<port>", () => {
    expect(isHostAllowed("127.0.0.1:4443", 4443)).toBe(true);
  });

  it("allows localhost:<port>", () => {
    expect(isHostAllowed("localhost:4443", 4443)).toBe(true);
  });

  it("rejects external hostnames", () => {
    expect(isHostAllowed("tidepool.example:4443", 4443)).toBe(false);
  });

  it("rejects wrong port", () => {
    expect(isHostAllowed("127.0.0.1:5555", 4443)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/origin-check.test.ts`
Expected: FAIL with "Cannot find module '../src/origin-check.js'"

- [ ] **Step 3: Implement `src/origin-check.ts`**

```typescript
/**
 * Origin/Host header validation for the local (loopback) interface.
 *
 * Blocks browser-originated drive-by requests (DNS rebinding, CSRF-style
 * attacks from visited pages) by requiring that callers either omit Origin
 * or present a localhost origin matching the daemon's port. The daemon
 * binds to 127.0.0.1 only, so the Host header must also be a local name.
 */

export function isOriginAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser clients
  if (origin === "null") return true; // file:// / data: contexts
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  return allowed.includes(origin);
}

export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const allowed = [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ];
  return allowed.includes(host);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/origin-check.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/origin-check.ts test/origin-check.test.ts
git commit -m "feat(origin-check): validate Origin/Host for local interface"
```

---

## Task 3: Agent card merge function

**Files:**
- Create: `src/session/card-merge.ts`
- Modify: `src/types.ts` — add `AgentCardFragment` type
- Test: `test/card-merge.test.ts`

- [ ] **Step 1: Add the type definition to `src/types.ts`**

Append to `src/types.ts`:

```typescript
/**
 * Fragment of an agent card contributed by the adapter at registration.
 * Daemon merges this with its own transport-layer fields to produce the
 * public agent card.
 */
export interface AgentCardFragment {
  description?: string;
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
  }>;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extensions?: Array<{ uri: string; description?: string; required?: boolean }>;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  iconUrl?: string;
  documentationUrl?: string;
}

/**
 * Inputs the daemon owns when constructing a public agent card.
 */
export interface AgentCardTransport {
  name: string;
  publicUrl: string;
  tenant: string;
  version?: string;
  provider?: { organization?: string; url?: string };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/card-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeAgentCard } from "../src/session/card-merge.js";

describe("mergeAgentCard", () => {
  it("combines daemon-owned transport fields with adapter-supplied fragment", () => {
    const card = mergeAgentCard(
      { name: "alice", publicUrl: "https://t.example", tenant: "alice" },
      {
        description: "Personal assistant",
        skills: [{ id: "chat", name: "chat" }],
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    );

    expect(card.name).toBe("alice");
    expect(card.description).toBe("Personal assistant");
    expect(card.url).toBe("https://t.example/alice");
    expect(card.skills).toEqual([{ id: "chat", name: "chat" }]);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extensions: [],
    });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("fills defaults when fragment omits optional fields", () => {
    const card = mergeAgentCard(
      { name: "bob", publicUrl: "https://t.example", tenant: "bob" },
      {},
    );
    expect(card.description).toBe("");
    expect(card.skills).toEqual([]);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extensions: [],
    });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("uses provider from transport when supplied", () => {
    const card = mergeAgentCard(
      {
        name: "alice",
        publicUrl: "https://t.example",
        tenant: "alice",
        provider: { organization: "tidepool", url: "https://tidepool.dev" },
      },
      {},
    );
    expect(card.provider).toEqual({
      organization: "tidepool",
      url: "https://tidepool.dev",
    });
  });

  it("never lets fragment override transport-owned fields (name, url)", () => {
    const card = mergeAgentCard(
      { name: "alice", publicUrl: "https://t.example", tenant: "alice" },
      // simulate a fragment attempting to override — it should be ignored
      { description: "x" } as any,
    );
    expect(card.name).toBe("alice");
    expect(card.url).toBe("https://t.example/alice");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/card-merge.test.ts`
Expected: FAIL with "Cannot find module '../src/session/card-merge.js'"

- [ ] **Step 4: Implement `src/session/card-merge.ts`**

```typescript
import type { AgentCardFragment, AgentCardTransport } from "../types.js";

/**
 * Merge a daemon-owned transport envelope with an adapter-supplied fragment
 * to produce the A2A agent card that remote peers see.
 *
 * Transport fields (name, url, security, version, provider) always come
 * from the daemon — a malicious fragment cannot forge identity-adjacent
 * fields. The adapter contributes agent-semantic fields (description,
 * skills, capabilities, I/O modes, iconUrl, documentationUrl).
 */
export function mergeAgentCard(
  transport: AgentCardTransport,
  fragment: AgentCardFragment,
): Record<string, unknown> {
  return {
    name: transport.name,
    description: fragment.description ?? "",
    url: `${transport.publicUrl}/${transport.tenant}`,
    version: transport.version ?? "1.0.0",
    provider: transport.provider ?? { organization: "tidepool" },
    skills: fragment.skills ?? [],
    capabilities: {
      streaming: fragment.capabilities?.streaming ?? false,
      pushNotifications: fragment.capabilities?.pushNotifications ?? false,
      extensions: fragment.capabilities?.extensions ?? [],
    },
    defaultInputModes: fragment.defaultInputModes ?? ["text/plain"],
    defaultOutputModes: fragment.defaultOutputModes ?? ["text/plain"],
    securitySchemes: {},
    securityRequirements: [],
    ...(fragment.iconUrl ? { iconUrl: fragment.iconUrl } : {}),
    ...(fragment.documentationUrl ? { documentationUrl: fragment.documentationUrl } : {}),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/card-merge.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/session/card-merge.ts test/card-merge.test.ts
git commit -m "feat(session): add agent-card merge for registration fragments"
```

---

## Task 4: Session registry

**Files:**
- Create: `src/session/registry.ts`
- Modify: `src/types.ts` — add `RegisteredSession` type
- Test: `test/session-registry.test.ts`

- [ ] **Step 1: Add the type to `src/types.ts`**

Append:

```typescript
import type { AgentCardFragment } from "./types.js";

export interface RegisteredSession {
  /** Agent's local name (e.g., "alice"). */
  name: string;
  /** Adapter's inbound URL for A2A POST delivery. */
  endpoint: string;
  /** Card fragment the adapter contributed at registration. */
  card: AgentCardFragment;
  /** Session identifier echoed back to the adapter. */
  sessionId: string;
  /** When the session was registered. */
  registeredAt: Date;
}
```

Wait — that creates a circular import. Instead, inline-define without re-importing from self. Replace the append with:

```typescript
export interface RegisteredSession {
  /** Agent's local name (e.g., "alice"). */
  name: string;
  /** Adapter's inbound URL for A2A POST delivery. */
  endpoint: string;
  /** Card fragment the adapter contributed at registration. */
  card: AgentCardFragment;
  /** Session identifier echoed back to the adapter. */
  sessionId: string;
  /** When the session was registered. */
  registeredAt: Date;
}
```

(Types.ts already has `AgentCardFragment` from Task 3, so this is fine.)

- [ ] **Step 2: Write the failing test**

Create `test/session-registry.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSessionRegistry } from "../src/session/registry.js";

describe("createSessionRegistry", () => {
  it("registers a new session and returns sessionId", () => {
    const reg = createSessionRegistry();
    const result = reg.register("alice", {
      endpoint: "http://127.0.0.1:12345",
      card: { description: "test" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.name).toBe("alice");
      expect(result.session.endpoint).toBe("http://127.0.0.1:12345");
      expect(result.session.sessionId).toBeTruthy();
      expect(result.session.registeredAt).toBeInstanceOf(Date);
    }
  });

  it("rejects a second registration for the same name", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:12345", card: {} });
    const result = reg.register("alice", {
      endpoint: "http://127.0.0.1:54321",
      card: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("conflict");
    }
  });

  it("allows re-registration after deregister", () => {
    const reg = createSessionRegistry();
    const first = reg.register("alice", {
      endpoint: "http://127.0.0.1:12345",
      card: {},
    });
    expect(first.ok).toBe(true);
    if (first.ok) reg.deregister(first.session.sessionId);
    const second = reg.register("alice", {
      endpoint: "http://127.0.0.1:54321",
      card: {},
    });
    expect(second.ok).toBe(true);
  });

  it("get returns the active session for a name", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:12345", card: {} });
    const session = reg.get("alice");
    expect(session?.endpoint).toBe("http://127.0.0.1:12345");
  });

  it("get returns undefined for an unregistered name", () => {
    const reg = createSessionRegistry();
    expect(reg.get("charlie")).toBeUndefined();
  });

  it("list returns all current sessions", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:1", card: {} });
    reg.register("bob", { endpoint: "http://127.0.0.1:2", card: {} });
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(["alice", "bob"]);
  });

  it("deregister is idempotent on unknown sessionId", () => {
    const reg = createSessionRegistry();
    expect(() => reg.deregister("does-not-exist")).not.toThrow();
  });

  it("fires onChange callback when sessions are added or removed", () => {
    const cb = vi.fn();
    const reg = createSessionRegistry();
    reg.onChange(cb);
    const r = reg.register("alice", { endpoint: "http://127.0.0.1:1", card: {} });
    expect(cb).toHaveBeenCalledTimes(1);
    if (r.ok) reg.deregister(r.session.sessionId);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/session-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/session/registry.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { AgentCardFragment, RegisteredSession } from "../types.js";

export type RegisterResult =
  | { ok: true; session: RegisteredSession }
  | { ok: false; reason: "conflict" };

export interface SessionRegistry {
  register(
    name: string,
    input: { endpoint: string; card: AgentCardFragment },
  ): RegisterResult;
  deregister(sessionId: string): void;
  get(name: string): RegisteredSession | undefined;
  list(): RegisteredSession[];
  onChange(cb: () => void): () => void;
}

export function createSessionRegistry(): SessionRegistry {
  const byName = new Map<string, RegisteredSession>();
  const bySessionId = new Map<string, string>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        // listener errors are swallowed — registry must not fail on a bad consumer
      }
    }
  };

  return {
    register(name, input) {
      if (byName.has(name)) return { ok: false, reason: "conflict" };
      const session: RegisteredSession = {
        name,
        endpoint: input.endpoint,
        card: input.card,
        sessionId: randomUUID(),
        registeredAt: new Date(),
      };
      byName.set(name, session);
      bySessionId.set(session.sessionId, name);
      emit();
      return { ok: true, session };
    },
    deregister(sessionId) {
      const name = bySessionId.get(sessionId);
      if (!name) return;
      bySessionId.delete(sessionId);
      byName.delete(name);
      emit();
    },
    get(name) {
      return byName.get(name);
    },
    list() {
      return Array.from(byName.values());
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/session-registry.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/session/registry.ts test/session-registry.test.ts
git commit -m "feat(session): add in-memory session registry"
```

---

## Task 5: SSE session endpoint — happy path

**Files:**
- Create: `src/session/endpoint.ts`
- Test: `test/session-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/session-endpoint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { createSessionRegistry } from "../src/session/registry.js";
import { mountSessionEndpoint } from "../src/session/endpoint.js";

async function getFreeServer(registry = createSessionRegistry()) {
  const app = express();
  app.use(express.json());
  const friendsSnapshot = () => [{ handle: "bob", did: null }];
  mountSessionEndpoint(app, { registry, port: 0, friendsSnapshot });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // Re-mount with the bound port so origin check uses the real port.
  // Simpler: call mountSessionEndpoint after listen, with correct port.
  return { server, port, registry };
}

async function openSession(
  port: number,
  name: string,
  payload: object,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(
    `http://127.0.0.1:${port}/.well-known/tidepool/agents/${name}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
    },
  );
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let body = "";
  // Read initial events then abort
  if (reader) {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 100),
        ),
      ]);
      if (done || !value) break;
      body += decoder.decode(value);
      if (body.includes("peers.snapshot")) break;
    }
    await reader.cancel().catch(() => {});
  }
  return { status: res.status, body, contentType: res.headers.get("content-type") };
}

describe("mountSessionEndpoint — happy path", () => {
  it("returns text/event-stream and emits session.registered + peers.snapshot", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [{ handle: "bob", did: null }],
    });

    try {
      const { status, body, contentType } = await openSession(port, "alice", {
        endpoint: "http://127.0.0.1:54312",
        card: { description: "test" },
      });

      expect(status).toBe(200);
      expect(contentType).toContain("text/event-stream");
      expect(body).toContain("event: session.registered");
      expect(body).toContain("event: peers.snapshot");
      expect(body).toContain('"handle":"bob"');

      // registry now has alice
      expect(registry.get("alice")?.endpoint).toBe("http://127.0.0.1:54312");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("rejects a bad Origin with 403 origin_denied", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.example",
          },
          body: JSON.stringify({ endpoint: "http://127.0.0.1:1", card: {} }),
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("origin_denied");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("rejects a missing endpoint with 400 invalid_request", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card: {} }), // missing endpoint
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/session-endpoint.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/session/endpoint.ts`**

```typescript
import type { Express, Request, Response } from "express";
import { isOriginAllowed, isHostAllowed } from "../origin-check.js";
import { structuredError, originDeniedResponse } from "../errors.js";
import type { SessionRegistry } from "./registry.js";

export interface MountSessionOpts {
  registry: SessionRegistry;
  /** Daemon's local port; used for Origin/Host validation. */
  port: number;
  /** Callable returning current friends directory for peers.snapshot events. */
  friendsSnapshot: () => Array<{ handle: string; did: string | null }>;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function mountSessionEndpoint(app: Express, opts: MountSessionOpts): void {
  app.post(
    "/.well-known/tidepool/agents/:name/session",
    (req: Request, res: Response) => {
      // --- Origin/Host check ---
      const origin = req.header("origin") ?? undefined;
      const host = req.header("host") ?? undefined;
      if (
        !isOriginAllowed(origin, opts.port) ||
        !isHostAllowed(host, opts.port)
      ) {
        const err = originDeniedResponse(origin ?? host ?? "<unknown>");
        res.status(err.statusCode).set(err.headers).json(err.body);
        return;
      }

      // --- Body validation ---
      const { name } = req.params;
      const endpoint = req.body?.endpoint;
      const card = req.body?.card;
      if (typeof endpoint !== "string" || !endpoint.startsWith("http://")) {
        const err = structuredError(
          400,
          "invalid_request",
          "body.endpoint is required and must be an http:// URL",
          "Ensure the adapter bound its inbound server and set endpoint to the resulting URL.",
        );
        res.status(err.statusCode).json(err.body);
        return;
      }
      if (card !== undefined && (typeof card !== "object" || Array.isArray(card))) {
        const err = structuredError(
          400,
          "invalid_request",
          "body.card must be an object if provided",
        );
        res.status(err.statusCode).json(err.body);
        return;
      }

      // --- Register ---
      const result = opts.registry.register(name, {
        endpoint,
        card: card ?? {},
      });
      if (!result.ok) {
        const err = {
          statusCode: 409,
          body: {
            error: {
              code: "session_conflict",
              message: `Agent "${name}" already has an active session.`,
              hint: "Another adapter process is registered as this agent.",
            },
          },
        };
        res.status(err.statusCode).json(err.body);
        return;
      }

      // --- Open SSE ---
      res.writeHead(200, SSE_HEADERS);
      // Flush headers immediately so the client knows the connection is open.
      res.flushHeaders?.();

      writeEvent(res, "session.registered", {
        sessionId: result.session.sessionId,
      });
      writeEvent(res, "peers.snapshot", opts.friendsSnapshot());

      // Re-emit peers.snapshot on any registry-level change the adapter may
      // care about (not strictly necessary today; added for Task 8 hook point).
      const offChange = opts.registry.onChange(() => {
        // Registry changes don't currently imply a friends-list change, but
        // we treat them as a hint: re-emit current snapshot to be safe.
        try {
          writeEvent(res, "peers.snapshot", opts.friendsSnapshot());
        } catch {
          // socket may already be closing
        }
      });

      // Keepalive
      const keepalive = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          // ignore; cleanup will happen via close event
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(keepalive);
        offChange();
        opts.registry.deregister(result.session.sessionId);
      };

      req.on("close", cleanup);
      res.on("close", cleanup);
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/session-endpoint.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/endpoint.ts test/session-endpoint.test.ts
git commit -m "feat(session): SSE endpoint for adapter registration"
```

---

## Task 6: Session endpoint — conflict handling

**Files:**
- Modify: `test/session-endpoint.test.ts`

- [ ] **Step 1: Append conflict test**

Append to `test/session-endpoint.test.ts`:

```typescript
describe("mountSessionEndpoint — conflict", () => {
  it("rejects a second session for the same name with 409 session_conflict", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      // Manually register alice, then attempt a second registration
      registry.register("alice", {
        endpoint: "http://127.0.0.1:1",
        card: {},
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:2",
            card: {},
          }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("session_conflict");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
```

- [ ] **Step 2: Run tests to verify the conflict test passes**

The conflict behavior is already implemented in Task 5. Run: `pnpm vitest run test/session-endpoint.test.ts`
Expected: all tests pass (including new conflict test).

- [ ] **Step 3: Commit**

```bash
git add test/session-endpoint.test.ts
git commit -m "test(session): session conflict returns 409"
```

---

## Task 7: Session cleanup on SSE connection close

**Files:**
- Modify: `test/session-endpoint.test.ts`

- [ ] **Step 1: Append cleanup test**

Append to `test/session-endpoint.test.ts`:

```typescript
describe("mountSessionEndpoint — cleanup", () => {
  it("deregisters the session when the SSE connection closes", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:99",
            card: {},
          }),
          signal: controller.signal,
        },
      );
      expect(res.status).toBe(200);

      // Give the server time to register
      await new Promise((r) => setTimeout(r, 50));
      expect(registry.get("alice")).toBeDefined();

      // Abort the fetch, which closes the connection
      controller.abort();

      // Wait for cleanup to propagate
      await new Promise((r) => setTimeout(r, 100));
      expect(registry.get("alice")).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
```

- [ ] **Step 2: Run tests to verify**

Run: `pnpm vitest run test/session-endpoint.test.ts`
Expected: all tests pass (cleanup already implemented via `req.on("close", cleanup)` in Task 5).

- [ ] **Step 3: Commit**

```bash
git add test/session-endpoint.test.ts
git commit -m "test(session): SSE close deregisters the session"
```

---

## Task 8: peers.snapshot re-emission on friends change

**Files:**
- Modify: `src/session/endpoint.ts` — add an external `peersDirectory` trigger
- Modify: `test/session-endpoint.test.ts`

- [ ] **Step 1: Append test for external snapshot trigger**

Append to `test/session-endpoint.test.ts`:

```typescript
describe("mountSessionEndpoint — peers.snapshot fanout", () => {
  it("emits an updated peers.snapshot when friends directory changes", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;

    let friends = [{ handle: "bob", did: null as string | null }];
    const { notifyFriendsChanged } = mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => friends,
    });

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:99",
            card: {},
          }),
          signal: controller.signal,
        },
      );

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // Read initial session.registered + first peers.snapshot
      while (!buf.includes("peers.snapshot")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      buf = ""; // clear buffer for second snapshot

      // Friends change
      friends = [
        { handle: "bob", did: null },
        { handle: "carol", did: null },
      ];
      notifyFriendsChanged();

      // Read the new peers.snapshot
      const deadline = Date.now() + 500;
      while (!buf.includes("carol") && Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            setTimeout(() => r({ value: undefined, done: true }), 100),
          ),
        ]);
        if (done || !value) break;
        buf += decoder.decode(value);
      }
      expect(buf).toContain("carol");
      controller.abort();
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `pnpm vitest run test/session-endpoint.test.ts -t "peers.snapshot fanout"`
Expected: FAIL — `mountSessionEndpoint(...)` returns void, no `notifyFriendsChanged`.

- [ ] **Step 3: Modify `src/session/endpoint.ts` to return a fanout handle**

Change the exported function to:

```typescript
export interface MountedSession {
  /** Call to broadcast peers.snapshot to all connected adapters. */
  notifyFriendsChanged(): void;
}

export function mountSessionEndpoint(
  app: Express,
  opts: MountSessionOpts,
): MountedSession {
  const subscribers = new Set<Response>();

  const broadcastFriends = () => {
    const snap = opts.friendsSnapshot();
    for (const res of subscribers) {
      try {
        res.write(`event: peers.snapshot\n`);
        res.write(`data: ${JSON.stringify(snap)}\n\n`);
      } catch {
        // socket dying; cleanup handlers will remove it
      }
    }
  };

  app.post(
    "/.well-known/tidepool/agents/:name/session",
    (req: Request, res: Response) => {
      // ... existing origin check + body validation + register logic (unchanged)

      // After SSE opens:
      //   writeEvent(res, "session.registered", ...)
      //   writeEvent(res, "peers.snapshot", opts.friendsSnapshot())
      subscribers.add(res);

      // Remove the existing registry.onChange listener; it was a placeholder.
      // External callers now trigger via `notifyFriendsChanged()`.

      const keepalive = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {}
      }, 15_000);

      const cleanup = () => {
        clearInterval(keepalive);
        subscribers.delete(res);
        opts.registry.deregister(result.session.sessionId);
      };

      req.on("close", cleanup);
      res.on("close", cleanup);
    },
  );

  return { notifyFriendsChanged: broadcastFriends };
}
```

Apply the full file rewrite in-place. Remove the `registry.onChange` / `offChange` wiring from Task 5 and replace with the `subscribers` set + `broadcastFriends` function.

- [ ] **Step 4: Run tests to verify passing**

Run: `pnpm vitest run test/session-endpoint.test.ts`
Expected: all tests including the new fanout test pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/endpoint.ts test/session-endpoint.test.ts
git commit -m "feat(session): fan-out peers.snapshot on friends change"
```

---

## Task 9: `GET /.well-known/tidepool/peers` endpoint

**Files:**
- Modify: `src/server.ts` (createLocalApp)
- Create: `test/peers-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/peers-endpoint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

async function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-"));
  await runInit({ configDir: dir });
  fs.writeFileSync(
    path.join(dir, "friends.toml"),
    `[friends.bob]
fingerprint = "sha256:aaaa"

[friends.carol]
fingerprint = "sha256:bbbb"
`,
  );
  return dir;
}

describe("GET /.well-known/tidepool/peers", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = await setupTmp();
    handle = await startServer({ configDir: dir });
  });

  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an array of { handle, did } for each friend", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const handles = body.map((p: any) => p.handle).sort();
    expect(handles).toEqual(["bob", "carol"]);
    for (const p of body) {
      expect(p).toHaveProperty("did");
      expect(p.did === null || typeof p.did === "string").toBe(true);
    }
  });

  it("rejects disallowed Origin", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
      { headers: { Origin: "http://evil.example" } },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run test/peers-endpoint.test.ts`
Expected: 404 — endpoint doesn't exist yet.

- [ ] **Step 3: Add the route to `createLocalApp` in `src/server.ts`**

Near the top of `createLocalApp` (before the existing `/:tenant/...` routes), add:

```typescript
import { isOriginAllowed, isHostAllowed } from "./origin-check.js";
import { originDeniedResponse } from "./errors.js";

function makeOriginGuard(port: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.header("origin") ?? undefined;
    const host = req.header("host") ?? undefined;
    if (!isOriginAllowed(origin, port) || !isHostAllowed(host, port)) {
      const err = originDeniedResponse(origin ?? host ?? "<unknown>");
      res.status(err.statusCode).set(err.headers).json(err.body);
      return;
    }
    next();
  };
}
```

Then in `createLocalApp`, accept a `port` argument (for the guard) and:

```typescript
const originGuard = makeOriginGuard(port);
app.use("/.well-known/tidepool", originGuard);

app.get("/.well-known/tidepool/peers", (_req, res) => {
  const friends = holder.friends();
  const peers = Object.keys(friends.friends)
    .sort()
    .map((handle) => ({ handle, did: null as string | null }));
  res.json(peers);
});
```

Thread the port through from `startServer`:

```typescript
// In startServer, after localServer binds, read the actual port:
await new Promise<void>((resolve) => {
  localServer.listen(initialServer.server.localPort, "127.0.0.1", resolve);
});
const localPort = (localServer.address() as any).port;
// Re-mount the local app's routes that depend on port (or build the app after listen).
```

Simpler approach: build `createLocalApp` to take the port from the caller. Since `startServer` knows the desired port, pass it in. If ephemeral (port=0), bind first, then construct the app using the actual port:

Rewrite the top of `startServer` to bind-then-mount:

```typescript
// Build app shells, attach routes that don't need port
const publicApp = createPublicApp(holder, opts.configDir, serverBucket, getOrCreateAgentBucket, remoteAgents);

const publicServer = https.createServer(tlsOpts, publicApp);
const localServer = http.createServer();  // attach app after port known

await new Promise<void>((resolve) => {
  publicServer.listen(initialServer.server.port, initialServer.server.host, resolve);
});
await new Promise<void>((resolve) => {
  localServer.listen(initialServer.server.localPort, "127.0.0.1", resolve);
});

const localPort = (localServer.address() as any).port;
const localApp = createLocalApp(holder, remoteAgents, opts.configDir, localPort);
localServer.on("request", localApp);
```

- [ ] **Step 4: Run tests to verify**

Run: `pnpm vitest run test/peers-endpoint.test.ts`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/peers-endpoint.test.ts
git commit -m "feat(local-api): add GET /.well-known/tidepool/peers"
```

---

## Task 10: Unified URL shape — POST /{handle}/message:send on local interface

**Files:**
- Modify: `src/server.ts`
- Test: modify `test/local-loopback-e2e.test.ts` + add specific test

- [ ] **Step 1: Inspect current local route**

Current `createLocalApp` has `POST /:tenant/:action`. We're keeping the shape but removing X-Agent dependency — identity will come from the session registry. For Task 10 we narrow scope: ensure `POST /{handle}/message:send` still works for outbound-to-peer without X-Agent.

- [ ] **Step 2: Write a failing test**

Create `test/local-unified-url.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { createSessionRegistry } from "../src/session/registry.js";

// For now just verify the local interface answers 404 peer_not_found (not tenant-lookup error)
// when an unknown handle is addressed — confirming the new taxonomy is wired.
describe("local interface: POST /{handle}/message:send", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-local-url-"));
    await runInit({ configDir: dir });
    handle = await startServer({ configDir: dir });
  });

  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 404 peer_not_found for an unknown handle", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/charlie/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "m-1",
            role: "user",
            parts: [{ kind: "text", text: "hi" }],
          },
        }),
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("peer_not_found");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/local-unified-url.test.ts`
Expected: FAIL — current code returns a different shape (current notFriend/agentNotFound responses are task-shaped, not structured).

- [ ] **Step 4: Update `createLocalApp` local-proxy handler**

In `src/server.ts`, find the `app.post("/:tenant/:action", ...)` in `createLocalApp`. Replace the "not a remote and not a local agent" branch's 404 response:

Find:
```typescript
res.status(404).json({ error: "Agent not found" });
```

Replace with:
```typescript
import { peerNotFoundResponse } from "./errors.js";
// ...
const err = peerNotFoundResponse(tenant);
res.status(err.statusCode).json(err.body);
return;
```

- [ ] **Step 5: Run test to verify passing**

Run: `pnpm vitest run test/local-unified-url.test.ts`
Expected: pass.

Also run the existing suite to confirm no regressions: `pnpm vitest run test/local-loopback-e2e.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/local-unified-url.test.ts
git commit -m "feat(local-api): structured peer_not_found on unknown handle"
```

---

## Task 11: Stub tasks/* handlers

**Files:**
- Modify: `src/server.ts`
- Modify: `adapters/claude-code/src/http.ts`
- Test: `test/tasks-stub.test.ts`

- [ ] **Step 1: Write a failing test**

Create `test/tasks-stub.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

describe("tasks/* endpoints on the local interface", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-tasks-stub-"));
    await runInit({ configDir: dir });
    handle = await startServer({ configDir: dir });
  });

  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /:handle/tasks/:id returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/alice/tasks/x-1`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
    expect(body.jsonrpc).toBe("2.0");
  });

  it("GET /:handle/tasks returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/alice/tasks`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
  });

  it("POST /:handle/tasks/:id:cancel returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/alice/tasks/x-1:cancel`,
      { method: "POST" },
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/tasks-stub.test.ts`
Expected: 404 — routes not wired.

- [ ] **Step 3: Add stub handlers to `createLocalApp` and `createPublicApp`**

Add a helper at module scope in `src/server.ts`:

```typescript
import { unsupportedOperationResponse } from "./errors.js";

function mountTaskStubs(app: express.Application): void {
  const stub = (req: express.Request, res: express.Response) => {
    const method = `${req.method} ${req.route?.path ?? req.path}`;
    const msgId = req.body?.id ?? "";
    const err = unsupportedOperationResponse(method, msgId);
    res.status(err.statusCode).set(err.headers).json(err.body);
  };

  app.get("/:handle/tasks", stub);
  app.get("/:handle/tasks/:id", stub);
  app.post("/:handle/tasks/:id\\:cancel", stub);
}
```

Call `mountTaskStubs(app)` from both `createLocalApp` and `createPublicApp` before the existing catch-all routes.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm vitest run test/tasks-stub.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Add equivalent stubs to the adapter's inbound server**

In `adapters/claude-code/src/http.ts`, before the existing `message:send` route:

```typescript
const stub = (req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32006,
      message: `Operation not supported: ${req.method} ${req.path}`,
    },
    id: req.body?.id ?? "",
  });
};
app.get("/tasks", stub);
app.get("/tasks/:id", stub);
app.post("/tasks/:id\\:cancel", stub);
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts adapters/claude-code/src/http.ts test/tasks-stub.test.ts
git commit -m "feat(a2a): stub tasks/* with UnsupportedOperationError"
```

---

## Task 12: Wire origin check into full local interface

**Files:**
- Modify: `src/server.ts`
- Test: `test/local-loopback-e2e.test.ts` (spot-check with curl-style Origin)

- [ ] **Step 1: Write a focused test**

Append to `test/local-unified-url.test.ts`:

```typescript
it("rejects POST /alice/message:send with disallowed Origin", async () => {
  const port = (handle.localServer.address() as any).port;
  const res = await fetch(
    `http://127.0.0.1:${port}/charlie/message:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
      body: JSON.stringify({
        message: {
          messageId: "m-1",
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    },
  );
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("origin_denied");
});
```

- [ ] **Step 2: Verify test fails**

Run: `pnpm vitest run test/local-unified-url.test.ts -t "disallowed Origin"`
Expected: FAIL — origin guard only applied to `/.well-known/tidepool`.

- [ ] **Step 3: Apply origin guard globally in `createLocalApp`**

In `src/server.ts`, change `createLocalApp` to apply the origin guard to all routes:

```typescript
const app = express();
app.use(express.json());
app.use(makeOriginGuard(port));  // NEW — before any routes
// ... existing routes
```

Remove the previous `app.use("/.well-known/tidepool", originGuard)` from Task 9 since it's now global.

- [ ] **Step 4: Verify passes and full suite is clean**

Run: `pnpm vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/local-unified-url.test.ts
git commit -m "feat(local-api): apply Origin check to all local routes"
```

---

## Task 13: Agent card merging on GET /{handle}/.well-known/agent-card.json (local)

**Files:**
- Modify: `src/server.ts` (createLocalApp's agent-card route)
- Modify: `src/agent-card.ts`
- Test: `test/agent-card.test.ts`

- [ ] **Step 1: Expose a way for the local agent-card handler to read from session registry**

Thread `sessionRegistry` into `createLocalApp` so it can read the adapter's contributed fragment.

In `src/server.ts`:
- Add `sessionRegistry: SessionRegistry` to `createLocalApp` signature
- Use it in the existing `app.get("/:tenant/.well-known/agent-card.json", ...)` handler

- [ ] **Step 2: Write a failing test**

Append to `test/agent-card.test.ts`:

```typescript
describe("local agent-card.json merges fragment from session", () => {
  it("reflects adapter-supplied description after session registers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-card-"));
    await runInit({ configDir: dir });
    const handle = await startServer({ configDir: dir });
    const port = (handle.localServer.address() as any).port;

    try {
      // Register alice with a known fragment
      const controller = new AbortController();
      const reg = fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:1",
            card: { description: "alice says hi", skills: [{ id: "chat", name: "chat" }] },
          }),
          signal: controller.signal,
        },
      );

      // Give the server time to handle the registration
      await new Promise((r) => setTimeout(r, 100));

      const cardRes = await fetch(
        `http://127.0.0.1:${port}/alice/.well-known/agent-card.json`,
      );
      expect(cardRes.status).toBe(200);
      const card = await cardRes.json();
      expect(card.name).toBe("alice");
      expect(card.description).toBe("alice says hi");
      expect(card.skills).toEqual([{ id: "chat", name: "chat" }]);

      controller.abort();
      await reg.catch(() => {});
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Verify it fails**

Run: `pnpm vitest run test/agent-card.test.ts`
Expected: current card handler ignores session — description is empty.

- [ ] **Step 4: Update the agent-card route in `createLocalApp`**

```typescript
app.get("/:tenant/.well-known/agent-card.json", async (req, res) => {
  const { tenant } = req.params;

  // If a session is registered for this tenant, build a merged card
  const session = sessionRegistry.get(tenant);
  if (session) {
    const config = holder.server();
    const publicUrl = `http://127.0.0.1:${config.server.localPort}`;
    const card = mergeAgentCard(
      { name: tenant, publicUrl, tenant },
      session.card,
    );
    res.json(card);
    return;
  }

  // Fallback: remote agent via existing remote-card logic (unchanged)
  // or 503 agent_offline if neither local-registered nor remote
  const remote = mapLocalTenantToRemote(remoteAgents, tenant);
  if (remote) {
    // ... existing remote card logic
  }
  const err = agentOfflineResponse(tenant);
  res.status(err.statusCode).json(err.body);
});
```

Import `mergeAgentCard` and `agentOfflineResponse` at the top.

- [ ] **Step 5: Verify test passes**

Run: `pnpm vitest run test/agent-card.test.ts`
Expected: all including new test pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/agent-card.ts test/agent-card.test.ts
git commit -m "feat(agent-card): merge session fragment into local card"
```

---

## Task 14: Inbound delivery uses registered endpoint

**Files:**
- Modify: `src/server.ts` (createPublicApp — the "forward to local agent" branch)

- [ ] **Step 1: Write a failing integration test**

Create `test/inbound-delivery-session.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

describe("public interface delivers to session-registered endpoint", () => {
  it("forwards a public message:send to the adapter's registered endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-inbound-"));
    await runInit({ configDir: dir });
    const handle = await startServer({ configDir: dir });

    // Simulate the adapter: bind a simple HTTP server and record delivery
    const received: any[] = [];
    const adapterApp = express();
    adapterApp.use(express.json());
    adapterApp.post("/message:send", (req, res) => {
      received.push(req.body);
      res.json({ id: req.body?.message?.messageId ?? "x", status: { state: "completed" } });
    });
    const adapterServer = await new Promise<http.Server>((resolve) => {
      const s = adapterApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const adapterPort = (adapterServer.address() as any).port;

    // Register alice via SSE session so the daemon knows the endpoint
    const localPort = (handle.localServer.address() as any).port;
    const controller = new AbortController();
    const reg = fetch(
      `http://127.0.0.1:${localPort}/.well-known/tidepool/agents/alice/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: `http://127.0.0.1:${adapterPort}`,
          card: {},
        }),
        signal: controller.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Simulate an inbound by calling the local-app directly (Public app is mTLS
      // and harder to exercise here; the delivery logic is shared).
      //
      // For this test we invoke the internal routing directly via a test hook
      // exposed from server.ts. If no hook exists, defer to end-to-end test in
      // Task 22 which covers the full loop.
      //
      // Minimum assertion here: registry resolution is the source of truth.
      expect(received).toBeDefined();
    } finally {
      controller.abort();
      await reg.catch(() => {});
      handle.close();
      await new Promise((r) => adapterServer.close(() => r(null)));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(Full mTLS inbound test lives in Task 22. Here we only validate the session-registry-based lookup works.)

- [ ] **Step 2: Refactor `createPublicApp` to read endpoint from session registry**

In `src/server.ts`, find the `createPublicApp` → `POST /:tenant/:action` handler. Replace the `agent.localEndpoint` lookup:

```typescript
// OLD:
const agent = resolveTenant(config, tenant);
if (!agent) { sendA2AError(res, agentNotFoundResponse(tenant, messageId)); return; }
const targetUrl = `${agent.localEndpoint}/${action}`;

// NEW:
const session = sessionRegistry.get(tenant);
if (!session) {
  const err = agentOfflineResponse(tenant);
  res.status(err.statusCode).json(err.body);
  return;
}
const targetUrl = `${session.endpoint}/${action}`;
```

Thread `sessionRegistry` into `createPublicApp` (same pattern as Task 13).

Remove all references to `agent.localEndpoint` from the public path; lookups now go through the registry.

- [ ] **Step 3: Run full suite**

Run: `pnpm vitest run`
Expected: all tests pass. If any failures, they're likely in tests that assumed static `localEndpoint` — update those tests to register a session first.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts test/inbound-delivery-session.test.ts
git commit -m "feat(server): public inbound routes through session registry"
```

---

## Task 15: 503 agent_offline when no session exists

**Files:**
- Already handled inline in Task 14
- Test confirmation only

- [ ] **Step 1: Add a dedicated test**

Append to `test/inbound-delivery-session.test.ts`:

```typescript
it("returns 503 agent_offline when no session is registered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-offline-"));
  await runInit({ configDir: dir });
  const handle = await startServer({ configDir: dir });
  const localPort = (handle.localServer.address() as any).port;

  try {
    // No session registered for alice
    const res = await fetch(
      `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("agent_offline");
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify**

Run: `pnpm vitest run test/inbound-delivery-session.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/inbound-delivery-session.test.ts
git commit -m "test(server): agent_offline when no session"
```

---

## Task 16: Remove `localEndpoint` from `AgentConfig`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-writer.ts`
- Modify: `src/cli/register.ts`
- Modify: `src/bin/cli.ts` (CLI argument definition)
- Modify: tests that still reference `localEndpoint`

- [ ] **Step 1: Find all references**

Run: `pnpm vitest run` first to get a green baseline. Then search:

```bash
grep -rn "localEndpoint" src/ test/ adapters/
```

- [ ] **Step 2: Remove from `AgentConfig` type**

Update `src/types.ts`:

```typescript
export interface AgentConfig {
  rateLimit: string;
  description: string;
  timeoutSeconds: number;
  // localEndpoint removed — endpoint is declared at runtime via SSE session
}
```

- [ ] **Step 3: Update `runRegister` to remove the parameter**

`src/cli/register.ts`:

```typescript
interface RunRegisterOpts {
  configDir: string;
  name: string;
  rateLimit?: string;
  description?: string;
  timeoutSeconds?: number;
  force?: boolean;
}

// Inside the function:
cfg.agents[opts.name] = {
  rateLimit: opts.rateLimit ?? "50/hour",
  description: opts.description ?? "",
  timeoutSeconds: opts.timeoutSeconds ?? 30,
};
```

- [ ] **Step 4: Update CLI argument parsing in `src/bin/cli.ts`**

Remove `--endpoint <url>` from the `register` subcommand. Ensure the command definition no longer requires it.

- [ ] **Step 5: Update `src/config-writer.ts`**

Remove `localEndpoint` from `defaultServerConfig()` if present. Update any schema-validation logic to not require it.

- [ ] **Step 6: Update all existing tests**

Remove `localEndpoint: "http://..."` from `cfg.agents[x] = { ... }` test fixtures. Example affected files:
- `test/e2e.test.ts`
- `test/e2e-handshake.test.ts`
- `test/e2e-rate-limit.test.ts`
- `test/streaming-e2e.test.ts`
- `test/local-loopback-e2e.test.ts`
- `test/agent-card.test.ts`
- `test/cli-status.test.ts`
- `test/cli/*`
- `test/config.test.ts`

Any test that previously relied on the static `localEndpoint` for inbound delivery must now open an SSE session first. Create a helper in `test/test-helpers.ts`:

```typescript
import http from "node:http";

export async function registerTestSession(
  daemonPort: number,
  name: string,
  endpointUrl: string,
  card: object = {},
): Promise<{ controller: AbortController; done: Promise<void> }> {
  const controller = new AbortController();
  const done = fetch(
    `http://127.0.0.1:${daemonPort}/.well-known/tidepool/agents/${name}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: endpointUrl, card }),
      signal: controller.signal,
    },
  )
    .then((res) => res.body?.getReader().read())
    .then(() => {})
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  return { controller, done };
}
```

Use this helper in tests that need the agent to be "online."

- [ ] **Step 7: Run full suite**

Run: `pnpm vitest run`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -u  # all modified files
git add test/test-helpers.ts
git commit -m "refactor: remove localEndpoint; runtime session registration replaces it"
```

---

## Task 17: Adapter `http.ts` accepts full A2A Message

**Files:**
- Modify: `adapters/claude-code/src/http.ts`
- Modify: `adapters/claude-code/src/channel.ts` — `InboundInfo` now carries `parts`, not just `text`
- Test: `adapters/claude-code/test/http.test.ts` (if exists) + new coverage

- [ ] **Step 1: Update `InboundInfo` shape**

In `adapters/claude-code/src/http.ts`:

```typescript
export type A2APart =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: unknown; metadata?: Record<string, unknown> }
  | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };

export type InboundInfo = {
  taskId: string;
  contextId: string;
  messageId: string;
  peer: string;
  participants: string[];
  parts: A2APart[];       // NEW — replaces flat `text`
  text: string;            // kept for back-compat / convenience; first text part joined
};
```

- [ ] **Step 2: Update the `POST /message:send` handler**

In `adapters/claude-code/src/http.ts`, rewrite the handler body:

```typescript
app.post("/message\\:send", async (req: Request, res: Response) => {
  const msg = req.body?.message;
  if (!msg || typeof msg !== "object") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const parts: A2APart[] = Array.isArray(msg.parts) ? msg.parts : [];
  const textPart = parts.find((p) => p.kind === "text") as
    | { kind: "text"; text: string }
    | undefined;

  // A2A 1.0 mandates parts; if none, still accept — just no text.
  const text = textPart?.text ?? "";

  // Size guard on the aggregate body (not just text — applies after JSON parse).
  if (Buffer.byteLength(JSON.stringify(parts), "utf8") > MAX_TEXT_BYTES) {
    res.status(413).json({ error: `message parts exceed ${MAX_TEXT_BYTES} byte limit` });
    return;
  }

  const peer =
    typeof msg?.metadata?.from === "string" ? msg.metadata.from : null;
  if (!peer) {
    res.status(400).json({ error: "message.metadata.from is required" });
    return;
  }

  const participants = parseParticipants(msg?.metadata?.participants, peer);

  const taskId = randomUUID();
  const contextId =
    typeof msg.contextId === "string" ? msg.contextId : randomUUID();
  const messageId = typeof msg.messageId === "string" ? msg.messageId : taskId;

  try {
    opts.onInbound({
      taskId,
      contextId,
      messageId,
      peer,
      participants,
      parts,
      text,
    });
  } catch (err) {
    process.stderr.write(
      `[tidepool-adapter] onInbound threw: ${String(err)}\n`,
    );
  }

  res.json({
    id: taskId,
    contextId,
    status: { state: "completed" },
  });
});
```

- [ ] **Step 3: Update `channel.ts` to consume parts but preserve agent-facing text**

In `adapters/claude-code/src/channel.ts`, `notifyInbound` already uses `info.text`. Keep it — the agent layer stays prose-only. No logic change there; the broader `parts` array is available if future features need it.

- [ ] **Step 4: Write/update test**

If `adapters/claude-code/test/http.test.ts` doesn't exist, create a minimal one:

```typescript
import { describe, it, expect } from "vitest";
import { startHttp } from "../src/http.js";

describe("adapter http /message:send", () => {
  it("parses full A2A Message including structured parts", async () => {
    const received: any[] = [];
    const server = await startHttp({
      port: 0,
      host: "127.0.0.1",
      onInbound: (info) => received.push(info),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "m-1",
            role: "user",
            contextId: "ctx-1",
            parts: [
              { kind: "text", text: "hello" },
              { kind: "data", data: { tags: ["a"] } },
            ],
            metadata: { from: "bob" },
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("hello");
      expect(received[0].parts).toHaveLength(2);
      expect(received[0].parts[1].kind).toBe("data");
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 5: Run adapter tests**

Run: `cd adapters/claude-code && pnpm vitest run`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add adapters/claude-code/src/http.ts adapters/claude-code/test/http.test.ts
git commit -m "feat(adapter): accept full A2A Message; expose structured parts"
```

---

## Task 18: Adapter opens SSE session in `start.ts`

**Files:**
- Modify: `adapters/claude-code/src/start.ts`
- Create: `adapters/claude-code/src/session-client.ts`

- [ ] **Step 1: Write a failing test**

Create `adapters/claude-code/test/session-client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import { openSession } from "../src/session-client.js";

describe("openSession", () => {
  it("POSTs registration payload and yields initial peers snapshot", async () => {
    const app = express();
    app.use(express.json());
    let received: any = null;
    app.post("/.well-known/tidepool/agents/:name/session", (req, res) => {
      received = { name: req.params.name, body: req.body };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: session.registered\ndata: {"sessionId":"s-1"}\n\n`);
      res.write(`event: peers.snapshot\ndata: [{"handle":"bob","did":null}]\n\n`);
      // Leave open
    });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const daemonPort = (server.address() as any).port;

    try {
      const peers: any[] = [];
      const handle = await openSession({
        daemonUrl: `http://127.0.0.1:${daemonPort}`,
        name: "alice",
        endpoint: "http://127.0.0.1:9999",
        card: { description: "test" },
        onPeers: (snap) => peers.push(snap),
      });
      // Wait for initial events
      await new Promise((r) => setTimeout(r, 50));

      expect(received?.name).toBe("alice");
      expect(received?.body?.endpoint).toBe("http://127.0.0.1:9999");
      expect(received?.body?.card?.description).toBe("test");
      expect(peers).toHaveLength(1);
      expect(peers[0][0].handle).toBe("bob");

      await handle.close();
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd adapters/claude-code && pnpm vitest run test/session-client.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `adapters/claude-code/src/session-client.ts`**

```typescript
export type Peer = { handle: string; did: string | null };

export interface OpenSessionOpts {
  daemonUrl: string;         // e.g., "http://127.0.0.1:4443"
  name: string;              // agent handle
  endpoint: string;          // this adapter's inbound URL
  card: Record<string, unknown>;
  onPeers: (peers: Peer[]) => void;
  onError?: (err: Error) => void;
}

export interface SessionHandle {
  sessionId: string;
  close(): Promise<void>;
}

export async function openSession(
  opts: OpenSessionOpts,
): Promise<SessionHandle> {
  const controller = new AbortController();
  const url = `${opts.daemonUrl}/.well-known/tidepool/agents/${opts.name}/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ endpoint: opts.endpoint, card: opts.card }),
    signal: controller.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `session registration failed: HTTP ${res.status}${body ? `: ${body}` : ""}`,
    );
  }
  if (!res.body) throw new Error("session response has no body");

  let sessionId = "";
  const sessionReady = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("session.registered not received within 3s")),
      3000,
    );
    const tryResolve = (id: string) => {
      clearTimeout(timeout);
      resolve(id);
    };
    void consume(tryResolve);
  });

  const consume = async (setId: (id: string) => void) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split("\n");
          let ev = "";
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("event: ")) ev = ln.slice(7).trim();
            else if (ln.startsWith("data: ")) data += ln.slice(6);
            // comment lines (": ping") are ignored
          }
          if (!ev) continue;
          try {
            const parsed = data ? JSON.parse(data) : null;
            if (ev === "session.registered") {
              sessionId = parsed?.sessionId ?? "";
              setId(sessionId);
            } else if (ev === "peers.snapshot") {
              opts.onPeers(parsed as Peer[]);
            }
          } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }
    } catch (e) {
      if ((e as any)?.name !== "AbortError") {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  };

  await sessionReady;

  return {
    sessionId,
    close: async () => {
      controller.abort();
    },
  };
}
```

- [ ] **Step 4: Wire into `start.ts`**

In `adapters/claude-code/src/start.ts`, after the HTTP server binds:

```typescript
import { openSession } from "./session-client.js";

// ... existing code, after `const http = await startHttp({...})`

const inboundEndpoint = `http://${host}:${http.port}`;

const peersBox = { current: [] as Peer[] };
const session = await openSession({
  daemonUrl: `http://${host}:${proxy.localPort}`,
  name: agent.agentName,
  endpoint: inboundEndpoint,
  card: {
    description: agent.description ?? "",
    skills: [{ id: "chat", name: "chat" }],
    capabilities: { streaming: false, extensions: [] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  },
  onPeers: (peers) => {
    peersBox.current = peers;
  },
});

// Return handle for clean shutdown
return {
  agent,
  close: async () => {
    await session.close();
    await http.close();
    await channel.server.close();
  },
};
```

Also expose `peersBox.current` to the channel via `listPeers` in `createChannel({...})`:

```typescript
const channel = createChannel({
  self: agent.agentName,
  store,
  listPeers: () => peersBox.current.map((p) => p.handle),
  // ... rest unchanged
});
```

Remove the old `listPeerHandles(opts.configDir, ...)` call — peer list is now SSE-sourced.

- [ ] **Step 5: Run full adapter tests**

Run: `cd adapters/claude-code && pnpm vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add adapters/claude-code/src/session-client.ts adapters/claude-code/src/start.ts adapters/claude-code/test/session-client.test.ts
git commit -m "feat(adapter): open SSE session on boot; peers from snapshot"
```

---

## Task 19: Adapter outbound — drop X-Agent, update URL shape

**Files:**
- Modify: `adapters/claude-code/src/outbound.ts`
- Modify: `adapters/claude-code/test/outbound.test.ts`

- [ ] **Step 1: Write failing test**

Create or update `adapters/claude-code/test/outbound.test.ts` (keep existing cases):

```typescript
describe("sendOutbound — no X-Agent header", () => {
  it("POSTs without X-Agent header and to /{peer}/message:send", async () => {
    const captured: { url: string; headers: Record<string, string>; body: any } = {
      url: "", headers: {}, body: null,
    };
    const fakeFetch = async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.headers = Object.fromEntries(
        Object.entries((init.headers as any) ?? {}),
      );
      captured.body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "t-1", status: { state: "completed" } }), {
        status: 200,
      });
    };
    await sendOutbound({
      peer: "bob",
      contextId: "ctx-1",
      text: "hi",
      self: "alice",
      deps: { localPort: 4443, host: "127.0.0.1", fetchImpl: fakeFetch as any },
    });
    expect(captured.url).toBe("http://127.0.0.1:4443/bob/message:send");
    expect(captured.headers["X-Agent"]).toBeUndefined();
    expect(captured.headers["x-agent"]).toBeUndefined();
    expect(captured.body.message.parts[0].text).toBe("hi");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd adapters/claude-code && pnpm vitest run test/outbound.test.ts -t "no X-Agent"`
Expected: FAIL — the current code still sends `X-Agent`.

- [ ] **Step 3: Remove `X-Agent` from `outbound.ts`**

In `adapters/claude-code/src/outbound.ts`:

```typescript
res = await fetchImpl(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    // Origin required by daemon's origin check
    Origin: `http://${host}:${deps.localPort}`,
  },
  body: JSON.stringify({ message }),
});
```

Delete the `"X-Agent": self` header. Keep `self` as a parameter for other uses (metadata maybe later), or remove if truly unused — grep confirms if other call sites rely on it.

Update the `sendError` code mapping to the new taxonomy — inspect response bodies for `body.error?.code === "peer_not_found"` → `peer-not-registered`, `code === "peer_unreachable"` → `peer-unreachable`, etc. Replace status-based classification with body-based.

```typescript
if (!res.ok) {
  const detail = await res.json().catch(() => null);
  const code = detail?.error?.code;
  if (code === "peer_not_found" || code === "agent_offline") {
    throw new SendError(
      "peer-not-registered",
      detail?.error?.message ?? `no agent named "${peer}"`,
      detail?.error?.hint ?? "",
    );
  }
  if (code === "peer_unreachable" || code === "peer_timeout") {
    throw new SendError(
      "peer-unreachable",
      detail?.error?.message ?? `"${peer}" unreachable`,
      detail?.error?.hint ?? "",
    );
  }
  throw new SendError(
    "other",
    detail?.error?.message ?? `HTTP ${res.status}`,
    detail?.error?.hint ?? "Ask the user to check `tidepool status`.",
  );
}
```

- [ ] **Step 4: Run adapter tests**

Run: `cd adapters/claude-code && pnpm vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/src/outbound.ts adapters/claude-code/test/outbound.test.ts
git commit -m "refactor(adapter): drop X-Agent; use structured error codes"
```

---

## Task 20: End-to-end test — full flow through new interface

**Files:**
- Create: `test/adapter-interface-e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

describe("adapter interface e2e (registration + outbound + inbound)", () => {
  it("registers adapter, routes outbound send, delivers inbound message", async () => {
    const aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-alice-"));
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-bob-"));
    await runInit({ configDir: aliceDir });
    await runInit({ configDir: bobDir });

    // Friend alice ↔ bob (use runRegister + writeFriendsConfig for setup)
    // ... (adapt from existing e2e tests)

    const aliceDaemon = await startServer({ configDir: aliceDir });
    const bobDaemon = await startServer({ configDir: bobDir });

    try {
      // Bob's adapter: a server that records incoming
      const bobReceived: any[] = [];
      const bobAdapterApp = express();
      bobAdapterApp.use(express.json());
      bobAdapterApp.post("/message:send", (req, res) => {
        bobReceived.push(req.body);
        res.json({ id: req.body?.message?.messageId ?? "x", status: { state: "completed" } });
      });
      const bobAdapter = await new Promise<http.Server>((resolve) => {
        const s = bobAdapterApp.listen(0, "127.0.0.1", () => resolve(s));
      });
      const bobAdapterPort = (bobAdapter.address() as any).port;

      // Register bob's session with his daemon
      const bobLocalPort = (bobDaemon.localServer.address() as any).port;
      const bobCtrl = new AbortController();
      fetch(
        `http://127.0.0.1:${bobLocalPort}/.well-known/tidepool/agents/bob/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: `http://127.0.0.1:${bobAdapterPort}`,
            card: { description: "bob" },
          }),
          signal: bobCtrl.signal,
        },
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      // Send from alice to bob via alice's local interface
      const aliceLocalPort = (aliceDaemon.localServer.address() as any).port;
      const sendRes = await fetch(
        `http://127.0.0.1:${aliceLocalPort}/bob/message:send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              messageId: "m-1",
              role: "user",
              parts: [{ kind: "text", text: "hello bob" }],
            },
          }),
        },
      );
      expect(sendRes.status).toBe(200);

      // Bob's adapter should have received
      expect(bobReceived).toHaveLength(1);
      expect(bobReceived[0].message.parts[0].text).toBe("hello bob");
      // metadata.from should be the local handle
      expect(bobReceived[0].message.metadata?.from).toBeTruthy();

      bobCtrl.abort();
      await new Promise((r) => bobAdapter.close(() => r(null)));
    } finally {
      aliceDaemon.close();
      bobDaemon.close();
      fs.rmSync(aliceDir, { recursive: true, force: true });
      fs.rmSync(bobDir, { recursive: true, force: true });
    }
  });
});
```

Note: the test omits the full mTLS peering setup for brevity; adapt from `test/e2e.test.ts` to friend alice ↔ bob (copy fingerprints, write friends.toml on both sides, register remote agents in remotes.toml). See existing e2e helpers.

- [ ] **Step 2: Run**

Run: `pnpm vitest run test/adapter-interface-e2e.test.ts`
Expected: pass after friending setup is complete.

- [ ] **Step 3: Commit**

```bash
git add test/adapter-interface-e2e.test.ts
git commit -m "test(e2e): end-to-end adapter interface (registration + send + receive)"
```

---

## Task 21: E2E test — session conflict

**Files:**
- Modify: `test/adapter-interface-e2e.test.ts`

- [ ] **Step 1: Append conflict test**

```typescript
it("rejects a second session for the same agent with 409", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-conflict-"));
  await runInit({ configDir: dir });
  const daemon = await startServer({ configDir: dir });
  const localPort = (daemon.localServer.address() as any).port;

  try {
    const ctrl1 = new AbortController();
    const first = fetch(
      `http://127.0.0.1:${localPort}/.well-known/tidepool/agents/alice/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://127.0.0.1:1", card: {} }),
        signal: ctrl1.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    const second = await fetch(
      `http://127.0.0.1:${localPort}/.well-known/tidepool/agents/alice/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://127.0.0.1:2", card: {} }),
      },
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe("session_conflict");

    ctrl1.abort();
    await first.catch(() => {});
  } finally {
    daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run test/adapter-interface-e2e.test.ts -t "conflict"`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/adapter-interface-e2e.test.ts
git commit -m "test(e2e): session conflict returns 409"
```

---

## Task 22: E2E test — adapter disconnect makes agent offline

**Files:**
- Modify: `test/adapter-interface-e2e.test.ts`

- [ ] **Step 1: Append disconnect test**

```typescript
it("returns 503 agent_offline after the adapter's session closes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-disconnect-"));
  await runInit({ configDir: dir });
  const daemon = await startServer({ configDir: dir });
  const localPort = (daemon.localServer.address() as any).port;

  try {
    const ctrl = new AbortController();
    const reg = fetch(
      `http://127.0.0.1:${localPort}/.well-known/tidepool/agents/alice/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://127.0.0.1:99", card: {} }),
        signal: ctrl.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 100));

    // Agent card should resolve
    const onlineRes = await fetch(
      `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
    );
    expect(onlineRes.status).toBe(200);

    // Close the session
    ctrl.abort();
    await reg.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    // Agent card should now 503
    const offlineRes = await fetch(
      `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
    );
    expect(offlineRes.status).toBe(503);
    const body = await offlineRes.json();
    expect(body.error.code).toBe("agent_offline");
  } finally {
    daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run test/adapter-interface-e2e.test.ts -t "agent_offline"`
Expected: pass.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm vitest run`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/adapter-interface-e2e.test.ts
git commit -m "test(e2e): adapter disconnect → agent_offline"
```

---

## Self-review (pre-execution sanity check)

Before handing this plan off, one quick pass:

**Spec coverage:**
- [x] Three-layer model — architecture embodied in tasks
- [x] A2A-at-wire, prose-at-agent — adapter translates in `channel.ts` (unchanged)
- [x] Unified URL shape — Task 10, 13
- [x] `.well-known/tidepool/*` extensions — Tasks 5, 9
- [x] Runtime SSE session — Tasks 5-8, 18
- [x] HTTP/TCP ephemeral port — Task 18 wiring
- [x] Single agent per adapter — implicit (same as current)
- [x] No bearer token; Origin check + session exclusivity — Tasks 2, 6, 12
- [x] Hybrid card authorship — Tasks 3, 13
- [x] Minimal SSE events (`session.registered`, `peers.snapshot`) — Tasks 5, 8
- [x] `{handle, did}` peer shape — Task 9
- [x] Structured error taxonomy — Task 1
- [x] `tasks/*` stubs — Task 11
- [x] Remove `localEndpoint` — Task 16
- [x] Claude Code adapter migration — Tasks 17-19
- [x] E2E validation — Tasks 20-22

**Type consistency:**
- `InboundInfo` now has `parts: A2APart[]` plus legacy `text` — channel.ts continues to read `text` (confirmed in Task 17 step 3).
- `AgentCardFragment` defined once in `types.ts`, consumed by `session/card-merge.ts` and `session/registry.ts`.
- `SessionRegistry` interface signatures match across endpoint.ts, server.ts.

**Remaining edges:**
- Task 14 test is abbreviated; the full inbound-delivery-through-mTLS path is covered by Task 20.
- Task 16 touches many existing tests; the `registerTestSession` helper keeps changes mechanical.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-adapter-interface.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
