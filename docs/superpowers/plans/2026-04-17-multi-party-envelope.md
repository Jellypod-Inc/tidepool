# Multi-party envelope improvements (P0–P2) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `self`, `addressed_to`, `in_reply_to`, shared `message_id`, and explicit delivery acks to Tidepool's multi-party protocol — with all protocol logic (fanout, handle projection, envelope stamping, validation) in the daemon, not the adapter.

**Architecture:** Envelope extensions ride on A2A `message.metadata` under a declared optional extension (`tidepool/multi-party-envelope/v1`). Wire-level identity is DIDs/fingerprints; each receiver's daemon re-projects into its own handle view. A new `POST /message:broadcast` endpoint on the local plane replaces adapter-side fanout.

**Tech stack:** TypeScript ESM, Node ≥20, Zod (wire validation), Vitest, pnpm workspace. A2A protocol with mTLS transport.

**Source spec:** `docs/superpowers/specs/2026-04-17-multi-party-envelope-design.md`

**Execution note:** This plan assumes today's codebase (adapter-side fanout at `adapters/claude-code/src/outbound.ts`, `POST /:tenant/message:send` URL shape). The `2026-04-17-adapter-interface-design` refactor will re-layer the broadcast URL under `.well-known/tidepool/*` when it ships; that's a cheap re-path.

---

## Phase 0 — Setup

### Task 0: Branch / working state

**Files:** none

- [ ] **Step 1: Ensure a clean working tree and a feature branch**

```bash
git status
git checkout -b feat/multi-party-envelope
```

Expected: clean status (the `.mcp.json` untracked file may still be present — leave it).

---

## Phase 1 — Identity helpers (foundations)

Every downstream task depends on these. Build them first so later tasks can compose.

### Task 1: DID↔handle translation helpers

**Files:**
- Modify: `src/peers/resolve.ts`
- Test: `test/peers/resolve.test.ts`

The existing `projectHandles` and `resolveHandle` work on string handles. We need helpers that round-trip between a canonical peer identity (the `did`-or-`fingerprint` string on a peer entry) and the handle as seen by a specific viewer.

- [ ] **Step 1: Sketch the contract**

Add to `src/peers/resolve.ts`:

```typescript
/**
 * Canonical per-agent identity: opaque string derived from a peer's DID or
 * fingerprint plus the agent name. Stable across daemons.
 *
 * Shape: `${peerDid}::${agent}` for remote, `self::${agent}` for local.
 */
export type AgentDid = string;

/** Peer identity: prefer DID, fall back to fingerprint. Throws on missing both. */
export function peerDid(entry: { did?: string; fingerprint?: string }): string {
  const id = entry.did ?? entry.fingerprint;
  if (!id) throw new Error("peer entry missing did and fingerprint");
  return id;
}

/** Local handle (in *viewer* projection) → canonical AgentDid. */
export function handleToAgentDid(
  handle: string,
  peers: PeersConfig,
  localAgents: string[],
): AgentDid {
  const resolved = resolveHandle(handle, peers, localAgents);
  if (resolved.kind === "local") return `self::${resolved.agent}`;
  const entry = peers.peers[resolved.peer];
  return `${peerDid(entry)}::${resolved.agent}`;
}

/**
 * Canonical AgentDid → handle in *viewer* projection. `viewer` is the
 * PeersConfig + localAgents of the daemon doing the projection; self-agents
 * on that daemon become `self/<agent>` when collision exists, otherwise bare.
 */
export function agentDidToHandle(
  did: AgentDid,
  peers: PeersConfig,
  localAgents: string[],
): string {
  const [peerId, agent] = did.split("::");
  if (!peerId || !agent) throw new Error(`invalid AgentDid: ${did}`);

  if (peerId === "self") {
    if (!localAgents.includes(agent)) throw new Error(`unknown local agent: ${agent}`);
    // delegate to projectHandles's collision logic
    const view = projectHandles(peers, localAgents);
    return view.find((h) => h === agent || h === `self/${agent}`)
      ?? `self/${agent}`;
  }

  const entryByPeer = Object.entries(peers.peers).find(
    ([, p]) => (p.did ?? p.fingerprint) === peerId,
  );
  if (!entryByPeer) throw new Error(`unknown peer identity: ${peerId}`);
  const [peerName, entry] = entryByPeer;
  if (!entry.agents.includes(agent)) throw new Error(`unknown agent on peer`);

  const view = projectHandles(peers, localAgents);
  return view.find((h) => h === agent || h === `${peerName}/${agent}`)
    ?? `${peerName}/${agent}`;
}
```

- [ ] **Step 2: Write failing tests**

Create `test/peers/resolve.test.ts` (append if it exists):

```typescript
import { describe, it, expect } from "vitest";
import {
  handleToAgentDid,
  agentDidToHandle,
  peerDid,
  projectHandles,
} from "../../src/peers/resolve.js";
import type { PeersConfig } from "../../src/types.js";

const peers: PeersConfig = {
  peers: {
    alice: { did: "did:key:alice", endpoint: "https://a", agents: ["writer", "editor"] },
    bob:   { did: "did:key:bob",   endpoint: "https://b", agents: ["writer"] },
  },
};

describe("DID↔handle helpers", () => {
  it("round-trips a bare handle when globally unique", () => {
    const localAgents = ["me"];
    const did = handleToAgentDid("editor", peers, localAgents);
    expect(did).toBe("did:key:alice::editor");
    expect(agentDidToHandle(did, peers, localAgents)).toBe("editor");
  });

  it("round-trips a scoped handle when agent name collides", () => {
    const localAgents: string[] = [];
    const did = handleToAgentDid("bob/writer", peers, localAgents);
    expect(did).toBe("did:key:bob::writer");
    expect(agentDidToHandle(did, peers, localAgents)).toBe("bob/writer");
  });

  it("round-trips self agents via self:: prefix", () => {
    const localAgents = ["me"];
    const did = handleToAgentDid("me", peers, localAgents);
    expect(did).toBe("self::me");
    expect(agentDidToHandle(did, peers, localAgents)).toBe("me");
  });

  it("re-projects across viewers (same DID, different projections)", () => {
    const viewerWithCollision: PeersConfig = {
      peers: {
        alice: { did: "did:key:alice", endpoint: "https://a", agents: ["writer"] },
      },
    };
    const localAgents = ["writer"]; // collides with alice/writer
    const did = "did:key:alice::writer";
    // viewer has local "writer", so alice's writer is scoped
    expect(agentDidToHandle(did, viewerWithCollision, localAgents))
      .toBe("alice/writer");
  });

  it("peerDid prefers did over fingerprint", () => {
    expect(peerDid({ did: "did:key:x", fingerprint: "sha256:y" })).toBe("did:key:x");
    expect(peerDid({ fingerprint: "sha256:y" })).toBe("sha256:y");
    expect(() => peerDid({})).toThrow();
  });

  it("rejects unknown handle", () => {
    expect(() => handleToAgentDid("ghost", peers, []))
      .toThrow(/no agent named ghost/);
  });
});
```

- [ ] **Step 3: Verify tests fail**

```bash
pnpm vitest run test/peers/resolve.test.ts
```

Expected: fail with "handleToAgentDid is not a function" (or similar missing-export error).

- [ ] **Step 4: Add the exports from Step 1 to `src/peers/resolve.ts`**

Append the code from Step 1 to the bottom of `src/peers/resolve.ts`. Import `PeersConfig` is already there.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run test/peers/resolve.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/peers/resolve.ts test/peers/resolve.test.ts
git commit -m "feat(resolve): add DID↔handle round-trip helpers

handleToAgentDid / agentDidToHandle translate between a canonical
per-agent identity (peer DID + agent name) and the handle as seen
by a given viewer's projection. Needed for per-recipient envelope
re-projection in multi-party sends."
```

---

### Task 2: Lightweight thread-index

**Files:**
- Create: `src/thread-index.ts`
- Test: `test/thread-index.test.ts`

Tracks `{context_id: Set<message_id>}` for `in_reply_to` validation. LRU-evicted. Fail-open on stale misses.

- [ ] **Step 1: Write failing tests**

Create `test/thread-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { ThreadIndex } from "../src/thread-index.js";

describe("ThreadIndex", () => {
  let idx: ThreadIndex;
  beforeEach(() => { idx = new ThreadIndex({ maxThreads: 3, maxIdsPerThread: 3 }); });

  it("records and checks ids within a thread", () => {
    idx.record("ctx1", "m1");
    idx.record("ctx1", "m2");
    expect(idx.has("ctx1", "m1")).toBe("present");
    expect(idx.has("ctx1", "m2")).toBe("present");
    expect(idx.has("ctx1", "never")).toBe("absent");
  });

  it("returns unknown for a thread we've never seen", () => {
    expect(idx.has("brand-new", "x")).toBe("unknown");
  });

  it("evicts oldest thread when over capacity", () => {
    idx.record("a", "x");
    idx.record("b", "x");
    idx.record("c", "x");
    idx.record("d", "x"); // evicts "a"
    expect(idx.has("a", "x")).toBe("unknown");
    expect(idx.has("d", "x")).toBe("present");
  });

  it("evicts oldest id within a thread when over per-thread cap", () => {
    idx.record("a", "1");
    idx.record("a", "2");
    idx.record("a", "3");
    idx.record("a", "4"); // evicts "1"
    expect(idx.has("a", "1")).toBe("absent"); // thread known; id specifically absent
    expect(idx.has("a", "4")).toBe("present");
  });

  it("updates thread recency on record", () => {
    idx.record("a", "1");
    idx.record("b", "1");
    idx.record("c", "1");
    idx.record("a", "2"); // bumps "a" to most-recent
    idx.record("d", "1"); // evicts "b" (oldest), not "a"
    expect(idx.has("a", "1")).toBe("present");
    expect(idx.has("b", "1")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Verify tests fail**

```bash
pnpm vitest run test/thread-index.test.ts
```

Expected: fail on missing module `../src/thread-index.js`.

- [ ] **Step 3: Implement the module**

Create `src/thread-index.ts`:

```typescript
export interface ThreadIndexOptions {
  maxThreads: number;
  maxIdsPerThread: number;
}

export type Presence = "present" | "absent" | "unknown";

interface Bucket {
  ids: Set<string>;
  order: string[]; // LRU within thread
  lastSeen: number;
}

export class ThreadIndex {
  private threads = new Map<string, Bucket>();
  private counter = 0;

  constructor(private opts: ThreadIndexOptions) {}

  record(contextId: string, messageId: string): void {
    let bucket = this.threads.get(contextId);
    if (!bucket) {
      bucket = { ids: new Set(), order: [], lastSeen: ++this.counter };
      this.threads.set(contextId, bucket);
      this.evictThreadsIfNeeded();
    } else {
      bucket.lastSeen = ++this.counter;
    }
    if (!bucket.ids.has(messageId)) {
      bucket.ids.add(messageId);
      bucket.order.push(messageId);
      while (bucket.order.length > this.opts.maxIdsPerThread) {
        const removed = bucket.order.shift()!;
        bucket.ids.delete(removed);
      }
    }
  }

  has(contextId: string, messageId: string): Presence {
    const bucket = this.threads.get(contextId);
    if (!bucket) return "unknown";
    return bucket.ids.has(messageId) ? "present" : "absent";
  }

  private evictThreadsIfNeeded(): void {
    if (this.threads.size <= this.opts.maxThreads) return;
    // Evict least-recently-seen thread(s)
    const sorted = [...this.threads.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen,
    );
    while (this.threads.size > this.opts.maxThreads) {
      const [oldest] = sorted.shift()!;
      this.threads.delete(oldest);
    }
  }
}

/** Singleton factory — bound by server.ts via config-holder. */
export function createDefaultThreadIndex(): ThreadIndex {
  return new ThreadIndex({ maxThreads: 1024, maxIdsPerThread: 1024 });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run test/thread-index.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/thread-index.ts test/thread-index.test.ts
git commit -m "feat(thread-index): LRU {context_id → Set<message_id>} index

Lightweight in-memory index for validating in_reply_to without
promoting full thread state to the daemon. Fail-open (unknown)
for threads beyond the LRU window."
```

---

## Phase 2 — Wire schema + extension declaration

### Task 3: Declare the A2A extension

**Files:**
- Create: `src/extensions.ts`
- Modify: `src/agent-card.ts`
- Test: `test/agent-card.test.ts`

- [ ] **Step 1: Add the extension URL constant**

Create `src/extensions.ts`:

```typescript
/** A2A extension URLs declared by this tidepool build. */
export const MULTI_PARTY_ENVELOPE_V1_URL =
  "https://tidepool.dev/extensions/multi-party-envelope/v1";
```

- [ ] **Step 2: Declare it in the agent card**

Modify `src/agent-card.ts`. Find the `extensions: [` block around line 37 and add a second entry:

```typescript
import { MULTI_PARTY_ENVELOPE_V1_URL } from "./extensions.js";

// …existing imports and setup…

extensions: [
  declareExtension(CONNECTION_EXTENSION_URL, {
    description: "Tidepool peer friending handshake",
    required: false,
  }),
  declareExtension(MULTI_PARTY_ENVELOPE_V1_URL, {
    description:
      "Multi-party envelope v1: self, addressed_to, in_reply_to, shared message_id, delivery acks",
    required: false,
  }),
],
```

- [ ] **Step 3: Write a test that the card advertises the extension**

Add to `test/agent-card.test.ts` (create if absent):

```typescript
import { describe, it, expect } from "vitest";
import { buildLocalAgentCard } from "../src/agent-card.js";
import { MULTI_PARTY_ENVELOPE_V1_URL } from "../src/extensions.js";

describe("agent-card extensions", () => {
  it("advertises multi-party-envelope/v1 as optional", () => {
    const card = buildLocalAgentCard(/* fixture args; follow existing test */);
    const ext = card.capabilities.extensions?.find(
      (e) => e.uri === MULTI_PARTY_ENVELOPE_V1_URL,
    );
    expect(ext).toBeDefined();
    expect(ext?.required).toBe(false);
  });
});
```

If `buildLocalAgentCard` takes args the test file already sets up, reuse the existing fixture. Otherwise read the function signature in `src/agent-card.ts` and mirror whatever other agent-card tests do in the repo.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run test/agent-card.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions.ts src/agent-card.ts test/agent-card.test.ts
git commit -m "feat(extension): declare multi-party-envelope/v1 A2A extension

required: false — old peers ignore unknown metadata and keep working
via prose coordination. Provides a negotiation point for adapters
that want to surface self/addressed_to/in_reply_to/delivery to agents."
```

---

### Task 4: Zod schemas for new metadata

**Files:**
- Modify: `src/a2a.ts`
- Modify: `src/wire-validation.ts`
- Test: `test/wire-validation.test.ts`

- [ ] **Step 1: Extend the metadata schema**

In `src/a2a.ts`, find the `MessageSchema` / metadata section (around line 194–260) and extend the metadata piece. If metadata is currently `z.record(z.unknown()).optional()`, tighten to a shape that includes our known fields while still accepting arbitrary ones:

```typescript
// At top of file or adjacent to existing schemas
export const TidepoolMetadataSchema = z
  .object({
    // existing
    from: z.string().optional(),
    participants: z.array(z.string()).optional(),
    // new (v1)
    addressed_to: z.array(z.string()).optional(),
    in_reply_to: z.string().optional(),
    self: z.string().optional(), // receiver-stamped
  })
  .catchall(z.unknown()); // allow unknown keys for forward-compat

// Replace the existing metadata field in MessageSchema:
//   metadata: z.record(z.unknown()).optional(),
// with:
//   metadata: TidepoolMetadataSchema.optional(),
```

Make sure the TypeScript `Message` interface in the same file includes the new optional fields in its metadata type.

- [ ] **Step 2: Surface metadata validation through wire-validation**

In `src/wire-validation.ts`, if there's a helper that validates inbound message bodies, ensure it uses the extended `MessageSchema`. Grep the file:

```bash
rg "MessageSchema" src/wire-validation.ts
```

If `MessageSchema` is referenced, the schema update in Step 1 is already wired. If not, add validation at the appropriate entry point following the existing pattern.

- [ ] **Step 3: Write schema tests**

Add to `test/wire-validation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TidepoolMetadataSchema } from "../src/a2a.js";

describe("TidepoolMetadataSchema", () => {
  it("accepts all v1 fields", () => {
    const parsed = TidepoolMetadataSchema.parse({
      from: "alice",
      participants: ["self::a", "did:key:b::x"],
      addressed_to: ["did:key:b::x"],
      in_reply_to: "msg-7",
      self: "alice",
    });
    expect(parsed.addressed_to).toEqual(["did:key:b::x"]);
  });

  it("rejects wrong types", () => {
    expect(() =>
      TidepoolMetadataSchema.parse({ addressed_to: "not-an-array" }),
    ).toThrow();
    expect(() =>
      TidepoolMetadataSchema.parse({ in_reply_to: 42 }),
    ).toThrow();
  });

  it("preserves unknown keys (forward-compat)", () => {
    const parsed = TidepoolMetadataSchema.parse({
      future_field: "okay",
    });
    expect((parsed as any).future_field).toBe("okay");
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run test/wire-validation.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean. If anywhere reads `message.metadata.participants` as `string[]` directly, this should still work; if anywhere reads it as a space-separated string from the adapter path, check those sites — `adapters/claude-code/src/channel.ts:376–388` currently stringifies. That will be updated in Task 12.

- [ ] **Step 6: Commit**

```bash
git add src/a2a.ts src/wire-validation.ts test/wire-validation.test.ts
git commit -m "feat(schema): extend A2A metadata with v1 multi-party fields

Adds optional addressed_to, in_reply_to, and self to TidepoolMetadataSchema.
Wire format: participants and addressed_to travel as canonical
AgentDid strings; self is the receiver-stamped handle in receiver view."
```

---

## Phase 3 — Daemon fanout endpoint

### Task 5: Broadcast request/response schemas

**Files:**
- Modify: `src/schemas.ts`
- Test: `test/schemas.test.ts`

- [ ] **Step 1: Add schemas**

Append to `src/schemas.ts`:

```typescript
export const BroadcastRequestSchema = z.object({
  peers: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  thread: z.string().uuid().optional(),
  addressed_to: z.array(z.string().min(1)).optional(),
  in_reply_to: z.string().min(1).optional(),
});
export type BroadcastRequest = z.infer<typeof BroadcastRequestSchema>;

export const BroadcastResultItemSchema = z.object({
  peer: z.string(),
  delivery: z.enum(["accepted", "failed"]),
  reason: z
    .object({
      kind: z.enum([
        "daemon-down",
        "peer-not-registered",
        "peer-unreachable",
        "other",
      ]),
      message: z.string(),
      hint: z.string().optional(),
    })
    .optional(),
});

export const BroadcastResponseSchema = z.object({
  context_id: z.string().uuid(),
  message_id: z.string().uuid(),
  results: z.array(BroadcastResultItemSchema),
});
export type BroadcastResponse = z.infer<typeof BroadcastResponseSchema>;
```

- [ ] **Step 2: Write tests**

Add to `test/schemas.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  BroadcastRequestSchema,
  BroadcastResponseSchema,
} from "../src/schemas.js";

describe("Broadcast schemas", () => {
  it("accepts a minimal request", () => {
    const req = BroadcastRequestSchema.parse({
      peers: ["alice"],
      text: "hi",
    });
    expect(req.peers).toEqual(["alice"]);
  });

  it("rejects empty peers", () => {
    expect(() => BroadcastRequestSchema.parse({ peers: [], text: "hi" }))
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
  });

  it("validates response shape", () => {
    const resp = BroadcastResponseSchema.parse({
      context_id: "00000000-0000-0000-0000-000000000001",
      message_id: "00000000-0000-0000-0000-000000000002",
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
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run test/schemas.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/schemas.ts test/schemas.test.ts
git commit -m "feat(schema): add BroadcastRequest/BroadcastResponse

Adapter calls daemon once per logical send; daemon returns the
shared message_id plus per-peer delivery outcome."
```

---

### Task 6: `POST /message:broadcast` handler — skeleton

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-broadcast.test.ts`

- [ ] **Step 1: Read the existing local-plane handler to understand auth + session pattern**

```bash
rg -n "message:send|X-Session-Id|resolveLocalHandle" src/server.ts | head -40
```

Note the `X-Session-Id` header validation at `server.ts:791` and the `resolveLocalHandleForRemoteSender` pattern at `server.ts:407`. Broadcast uses the same session auth (sender is the adapter whose session is open).

- [ ] **Step 2: Write the failing test**

Create `test/server-broadcast.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestDaemon } from "./helpers/daemon.js"; // existing helper; if named differently, adapt

describe("POST /message:broadcast", () => {
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  beforeEach(async () => { daemon = await startTestDaemon(); });
  afterEach(async () => { await daemon.stop(); });

  it("rejects without X-Session-Id", async () => {
    const r = await fetch(`${daemon.localUrl}/message:broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peers: ["alice"], text: "hi" }),
    });
    expect(r.status).toBe(401);
  });

  it("rejects empty peers", async () => {
    const r = await fetch(`${daemon.localUrl}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": daemon.sessionId,
      },
      body: JSON.stringify({ peers: [], text: "hi" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 200 with shared message_id for a single local-only peer", async () => {
    // Fixture: daemon has two local agents A (session holder) and B (target).
    const r = await fetch(`${daemon.localUrl}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": daemon.sessionId,
      },
      body: JSON.stringify({ peers: ["B"], text: "hello B" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.message_id).toBeTruthy();
    expect(body.context_id).toBeTruthy();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].peer).toBe("B");
    expect(body.results[0].delivery).toBe("accepted");
  });
});
```

If `test/helpers/daemon.ts` doesn't exist, look in `test/` for any existing e2e setup (the architecture notes mention `e2e-*.test.ts` multi-daemon tests). Follow that pattern; don't invent a new helper layer.

- [ ] **Step 3: Verify tests fail**

```bash
pnpm vitest run test/server-broadcast.test.ts
```

Expected: failures — either 404 (endpoint missing) or helper-missing errors.

- [ ] **Step 4: Register the route**

In `src/server.ts`, add a new handler for `POST /message:broadcast` on the **local plane only** (same plane where `X-Session-Id` is honored; the public plane should reject `message:broadcast` with 404).

```typescript
// Adjacent to the existing local-plane routes that handle /:tenant/message:send.
// Pseudocode shape — adapt to the existing router conventions:

app.post("/message:broadcast", async (req, res) => {
  // 1. Auth: X-Session-Id → sender agent
  const sessionId = req.headers["x-session-id"];
  if (typeof sessionId !== "string") return respondError(res, 401, "missing_session");
  const senderAgent = sessionRegistry.findAgentBySessionId(sessionId);
  if (!senderAgent) return respondError(res, 401, "invalid_session");

  // 2. Parse body
  const parsed = BroadcastRequestSchema.safeParse(req.body);
  if (!parsed.success) return respondError(res, 400, "invalid_body", parsed.error);
  const { peers, text, thread, addressed_to, in_reply_to } = parsed.data;

  // 3. Handler (Task 7+ fills this in). For now: stub to one local peer only.
  const handler = getBroadcastHandler(); // injected from server setup
  const result = await handler.run({
    senderAgent, peers, text, thread, addressed_to, in_reply_to,
  });

  return res.status(200).json(result);
});
```

Extract the actual broadcast logic into a separate module — keeps the server thin. Create `src/broadcast.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { PeersConfig } from "./types.js";
import type { ThreadIndex } from "./thread-index.js";
import {
  handleToAgentDid,
  agentDidToHandle,
} from "./peers/resolve.js";
import type { BroadcastResponse } from "./schemas.js";

export interface BroadcastDeps {
  peers: () => PeersConfig;
  localAgents: () => string[];
  threadIndex: ThreadIndex;
  deliverLocal: (
    targetAgent: string,
    body: unknown,
  ) => Promise<"accepted" | { kind: string; message: string; hint?: string }>;
  deliverRemote: (
    peerName: string,
    targetAgent: string,
    body: unknown,
  ) => Promise<"accepted" | { kind: string; message: string; hint?: string }>;
}

export interface BroadcastInput {
  senderAgent: string;
  peers: string[];
  text: string;
  thread?: string;
  addressed_to?: string[];
  in_reply_to?: string;
}

export class BroadcastHandler {
  constructor(private deps: BroadcastDeps) {}

  async run(input: BroadcastInput): Promise<BroadcastResponse> {
    const peersConfig = this.deps.peers();
    const localAgents = this.deps.localAgents();
    const contextId = input.thread ?? randomUUID();
    const messageId = randomUUID();

    // 1. Resolve recipient handles to AgentDids from sender's viewpoint
    const recipientDids = input.peers.map((h) =>
      handleToAgentDid(h, peersConfig, localAgents),
    );

    // 2. Validate addressed_to ⊆ peers
    if (input.addressed_to) {
      const addressedDids = new Set(
        input.addressed_to.map((h) => handleToAgentDid(h, peersConfig, localAgents)),
      );
      for (const d of addressedDids) {
        if (!recipientDids.includes(d)) {
          throw new BroadcastValidationError("invalid_addressed_to", {
            handle: [...addressedDids].find((x) => x === d)!,
          });
        }
      }
      input.addressed_to = [...addressedDids]; // canonicalize for wire
    }

    // 3. Validate in_reply_to if provided
    if (input.in_reply_to) {
      const presence = this.deps.threadIndex.has(contextId, input.in_reply_to);
      if (presence === "absent") {
        throw new BroadcastValidationError("invalid_in_reply_to", {
          message_id: input.in_reply_to,
        });
      }
      // presence === "unknown" → fail-open, accept
    }

    // 4. Participants (in DIDs) = sender + all recipients
    const senderDid = `self::${input.senderAgent}`;
    const participantDids = [senderDid, ...recipientDids];

    // 5. Fan out; record local copy in thread-index
    this.deps.threadIndex.record(contextId, messageId);

    const results = await Promise.all(
      recipientDids.map((did, i) => this.deliverOne(did, i, {
        contextId, messageId, text: input.text,
        senderDid, participantDids,
        addressedTo: input.addressed_to,
        inReplyTo: input.in_reply_to,
        displayName: input.peers[i],
      })),
    );

    return { context_id: contextId, message_id: messageId, results };
  }

  private async deliverOne(
    did: string,
    _idx: number,
    ctx: {
      contextId: string; messageId: string; text: string;
      senderDid: string; participantDids: string[];
      addressedTo?: string[]; inReplyTo?: string;
      displayName: string;
    },
  ): Promise<BroadcastResponse["results"][number]> {
    const [peerId, agent] = did.split("::");
    const body = {
      message: {
        messageId: ctx.messageId,
        contextId: ctx.contextId,
        role: "user",
        parts: [{ kind: "text", text: ctx.text }],
        metadata: {
          participants: ctx.participantDids,
          ...(ctx.addressedTo ? { addressed_to: ctx.addressedTo } : {}),
          ...(ctx.inReplyTo ? { in_reply_to: ctx.inReplyTo } : {}),
        },
        extensions: [
          "https://tidepool.dev/extensions/multi-party-envelope/v1",
        ],
      },
    };

    const outcome = peerId === "self"
      ? await this.deps.deliverLocal(agent, body)
      : await this.deps.deliverRemote(peerId, agent, body);

    if (outcome === "accepted") {
      return { peer: ctx.displayName, delivery: "accepted" };
    }
    return { peer: ctx.displayName, delivery: "failed", reason: outcome };
  }
}

export class BroadcastValidationError extends Error {
  constructor(public code: string, public detail: Record<string, unknown>) {
    super(code);
  }
}
```

Wire `BroadcastHandler` into server setup via `config-holder.ts` or the existing DI pattern — whichever `src/server.ts` uses for injecting request-scoped helpers.

- [ ] **Step 5: Implement `deliverLocal` and `deliverRemote` by reusing existing code paths**

`deliverLocal`: look for the existing local-to-local forward in `src/server.ts` (around `server.ts:388`). Factor it into a function that takes an A2A body and the target agent name, returns either `"accepted"` or an error reason. Use that function from the handler.

`deliverRemote`: look for the existing local-to-remote mTLS POST in `src/server.ts:716–731`. Same pattern — factor it into a function.

Do NOT duplicate the send logic. If you find yourself copy-pasting, stop and extract.

- [ ] **Step 6: Run tests**

```bash
pnpm vitest run test/server-broadcast.test.ts
```

Expected: the three tests from Step 2 pass. Iterate if not.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/broadcast.ts test/server-broadcast.test.ts
git commit -m "feat(daemon): POST /message:broadcast endpoint

Single-call multi-peer fanout. Mints shared message_id and context_id,
validates addressed_to ⊆ peers and in_reply_to via thread-index,
delegates per-peer delivery to existing local/remote send paths."
```

---

### Task 7: Inbound — stamp `self` and re-project envelope

**Files:**
- Modify: `src/server.ts` (inbound handler around `server.ts:264–486`)
- Test: `test/server-inbound-stamping.test.ts`

The inbound handler currently stamps `metadata.from` (see `server.ts:407, 431`). Add: stamp `self`, re-project `participants` and `addressed_to` from AgentDids → receiver-view handles.

- [ ] **Step 1: Write failing tests**

Create `test/server-inbound-stamping.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTwoDaemonFixture } from "./helpers/two-daemons.js"; // or adapt to existing pattern

describe("inbound metadata stamping (v1 envelope)", () => {
  let fx: Awaited<ReturnType<typeof startTwoDaemonFixture>>;
  beforeEach(async () => { fx = await startTwoDaemonFixture(); });
  afterEach(async () => { await fx.stop(); });

  it("stamps self on inbound in receiver's projection", async () => {
    // Sender on daemon A addresses agent "bob" on daemon B.
    // On B's adapter, the inbound envelope should carry self="bob".
    const msg = await fx.sendAndAwaitInbound({
      from: "A", senderAgent: "alice",
      to: ["bob"], text: "hi bob",
    });
    expect(msg.metadata.self).toBe("bob");
  });

  it("re-projects participants into receiver's view", async () => {
    // 3-peer: daemon A (alice) sends to B (bob) and C (carol).
    // Bob's inbound participants should be ["alice","bob","carol"] in bob's
    // projection, not in alice's.
    const msg = await fx.sendMultiAndAwait({ to: "bob" });
    expect(msg.metadata.participants).toEqual(
      expect.arrayContaining(["alice", "bob", "carol"]),
    );
    expect(msg.metadata.participants).toHaveLength(3);
  });

  it("re-projects addressed_to likewise", async () => {
    const msg = await fx.sendAddressedAndAwait({
      to: "bob", addressedToHandle: "carol",
    });
    // carol's handle in bob's view might be bare or scoped depending on
    // bob's local agents; the fixture should assert the correct projection.
    expect(msg.metadata.addressed_to).toEqual([fx.handleOf("carol", "bob")]);
  });

  it("records message_id into the thread-index on inbound", async () => {
    const msg = await fx.sendAndAwaitInbound({
      from: "A", senderAgent: "alice",
      to: ["bob"], text: "one",
    });
    // Subsequent reply with in_reply_to=msg.message_id must succeed.
    const reply = await fx.send({
      from: "B", senderAgent: "bob",
      to: ["alice"], text: "back at ya", inReplyTo: msg.message_id,
    });
    expect(reply.status).toBe(200);
  });
});
```

- [ ] **Step 2: Verify tests fail**

```bash
pnpm vitest run test/server-inbound-stamping.test.ts
```

Expected: failures — `self` missing, participants carry AgentDids not handles, etc.

- [ ] **Step 3: Extend the inbound stamping**

In `src/server.ts`, locate the inbound forward block (`server.ts:264–486`, near where `metadata.from` is injected at line 431). Add:

```typescript
import { agentDidToHandle } from "./peers/resolve.js";
import { threadIndex } from "./thread-index-instance.js"; // or inject via existing DI

// After resolving the local recipient agent (the one the URL path resolves to),
// and before forwarding to the adapter session:

const peersConfig = getPeersConfig();
const localAgents = getLocalAgents();

// 1. Stamp self
message.metadata ??= {};
message.metadata.self = localAgentName; // the agent this inbound is destined for

// 2. Re-project participants (if present)
if (Array.isArray(message.metadata.participants)) {
  message.metadata.participants = message.metadata.participants.map((did: string) => {
    try { return agentDidToHandle(did, peersConfig, localAgents); }
    catch { return did; /* unknown DID — pass through opaque */ }
  });
}

// 3. Re-project addressed_to (if present)
if (Array.isArray(message.metadata.addressed_to)) {
  message.metadata.addressed_to = message.metadata.addressed_to.map((did: string) => {
    try { return agentDidToHandle(did, peersConfig, localAgents); }
    catch { return did; }
  });
}

// 4. Record in thread-index for future in_reply_to validation
if (message.contextId && message.messageId) {
  threadIndex.record(message.contextId, message.messageId);
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run test/server-inbound-stamping.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-inbound-stamping.test.ts
git commit -m "feat(server): stamp self + re-project envelope on inbound

Receiver's daemon translates wire-level AgentDids into the receiver's
handle projection before forwarding to the adapter. Records
message_id into the thread-index for in_reply_to validation."
```

---

### Task 8: Wire validation errors (`invalid_addressed_to`, `invalid_in_reply_to`)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/broadcast.ts`
- Test: `test/server-broadcast.test.ts` (add cases)

- [ ] **Step 1: Map BroadcastValidationError → HTTP error response**

In the `/message:broadcast` handler in `src/server.ts`, wrap the `handler.run` call:

```typescript
try {
  const result = await handler.run({ /* … */ });
  return res.status(200).json(result);
} catch (e) {
  if (e instanceof BroadcastValidationError) {
    return res.status(400).json({ code: e.code, detail: e.detail });
  }
  throw e;
}
```

- [ ] **Step 2: Add tests for the two validation errors**

Append to `test/server-broadcast.test.ts`:

```typescript
it("rejects addressed_to containing a non-peer handle", async () => {
  const r = await fetch(`${daemon.localUrl}/message:broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": daemon.sessionId,
    },
    body: JSON.stringify({
      peers: ["B"], text: "x", addressed_to: ["ghost"],
    }),
  });
  expect(r.status).toBe(400);
  const body = await r.json();
  expect(body.code).toBe("invalid_addressed_to");
});

it("rejects in_reply_to referencing a message from a different thread", async () => {
  // First send to thread T1 and get message M.
  const send1 = await fetch(`${daemon.localUrl}/message:broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": daemon.sessionId,
    },
    body: JSON.stringify({ peers: ["B"], text: "one" }),
  });
  const body1 = await send1.json();
  const msgId = body1.message_id;

  // Send with in_reply_to=msgId in a *different* (auto-minted) thread.
  const send2 = await fetch(`${daemon.localUrl}/message:broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": daemon.sessionId,
    },
    body: JSON.stringify({ peers: ["B"], text: "two", in_reply_to: msgId }),
  });
  expect(send2.status).toBe(400);
  const body2 = await send2.json();
  expect(body2.code).toBe("invalid_in_reply_to");
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run test/server-broadcast.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/broadcast.ts test/server-broadcast.test.ts
git commit -m "feat(broadcast): surface invalid_addressed_to and invalid_in_reply_to

400 responses with structured {code, detail} so the sender's adapter
(and its agent) can learn the failure mode precisely."
```

---

## Phase 4 — Adapter migration

### Task 9: `outbound.ts` — single-call rewrite

**Files:**
- Modify: `adapters/claude-code/src/outbound.ts`
- Test: `adapters/claude-code/test/outbound.test.ts` (create or append)

- [ ] **Step 1: Read the current fanout implementation**

```bash
sed -n '1,150p' adapters/claude-code/src/outbound.ts
```

Today the file POSTs to `http://127.0.0.1:${localPort}/${peerHandle}/message:send` per peer and aggregates. Replace with a single POST to `/message:broadcast`.

- [ ] **Step 2: Replace the public function**

Rewrite `adapters/claude-code/src/outbound.ts`:

```typescript
import type {
  BroadcastRequest,
  BroadcastResponse,
} from "../../../src/schemas.js"; // adjust relative import to workspace layout

export interface OutboundOpts {
  localPort: number;
  sessionId: string;
  peers: string[];
  text: string;
  thread?: string;
  addressed_to?: string[];
  in_reply_to?: string;
}

export async function sendBroadcast(opts: OutboundOpts): Promise<BroadcastResponse> {
  const body: BroadcastRequest = {
    peers: opts.peers,
    text: opts.text,
    ...(opts.thread ? { thread: opts.thread } : {}),
    ...(opts.addressed_to ? { addressed_to: opts.addressed_to } : {}),
    ...(opts.in_reply_to ? { in_reply_to: opts.in_reply_to } : {}),
  };

  const res = await fetch(
    `http://127.0.0.1:${opts.localPort}/message:broadcast`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "tidepool-adapter",
        "X-Session-Id": opts.sessionId,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const detail = await safeJson(res);
    throw new BroadcastError(res.status, detail);
  }
  return (await res.json()) as BroadcastResponse;
}

async function safeJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

export class BroadcastError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(`broadcast_failed:${status}`);
  }
}
```

Delete the old per-peer fanout loop. If other adapters in the workspace still reference the old per-peer helper, leave a shim that throws `DeprecatedError` so the compiler catches stragglers.

- [ ] **Step 3: Tests**

Append/create `adapters/claude-code/test/outbound.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sendBroadcast, BroadcastError } from "../src/outbound.js";

describe("sendBroadcast", () => {
  it("serializes v1 fields correctly", async () => {
    // Mock fetch; assert the POST body.
    const original = globalThis.fetch;
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          context_id: "00000000-0000-0000-0000-000000000001",
          message_id: "00000000-0000-0000-0000-000000000002",
          results: [{ peer: "alice", delivery: "accepted" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      await sendBroadcast({
        localPort: 8080, sessionId: "s",
        peers: ["alice", "bob"], text: "hi",
        addressed_to: ["alice"], in_reply_to: "m1",
      });
      expect(capturedBody).toEqual({
        peers: ["alice", "bob"], text: "hi",
        addressed_to: ["alice"], in_reply_to: "m1",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws BroadcastError on non-2xx", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "invalid_addressed_to" }), { status: 400 })
    ) as typeof fetch;
    try {
      await expect(sendBroadcast({
        localPort: 8080, sessionId: "s",
        peers: ["alice"], text: "hi", addressed_to: ["ghost"],
      })).rejects.toBeInstanceOf(BroadcastError);
    } finally {
      globalThis.fetch = original;
    }
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm -C adapters/claude-code test
```

Expected: new tests pass; any previously-passing outbound tests that referenced the old fanout API fail — update them to use `sendBroadcast`.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/src/outbound.ts adapters/claude-code/test/outbound.test.ts
git commit -m "refactor(adapter): outbound uses POST /message:broadcast

Single daemon call replaces the per-peer fanout loop. Protocol logic
(fanout, handle translation, shared message_id minting) now lives in
the daemon; adapter is a pure translator."
```

---

### Task 10: `channel.ts` — updated `send` tool schema

**Files:**
- Modify: `adapters/claude-code/src/channel.ts`
- Test: `adapters/claude-code/test/channel.test.ts`

- [ ] **Step 1: Update the MCP tool schema**

In `adapters/claude-code/src/channel.ts`, find `SendArgsSchema` (around line 85). Extend:

```typescript
const SendArgsSchema = z.object({
  peers: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  thread: z.string().optional(),
  addressed_to: z.array(z.string().min(1)).optional(),
  in_reply_to: z.string().min(1).optional(),
});
```

Also update the MCP tool description string to document the two new optional fields. Reference the spec with a one-liner.

- [ ] **Step 2: Update the send handler**

Around `channel.ts:152–238`:

```typescript
// Replace the per-peer fanout + adapter-side participants stamping with:
const result = await sendBroadcast({
  localPort: opts.localPort,
  sessionId: opts.sessionId,
  peers: uniquePeers,
  text: parts.text,
  thread: opts.thread,           // from tool input
  addressed_to: opts.addressed_to,
  in_reply_to: opts.in_reply_to,
});

// Record into local thread-store with the shared message_id
threadStore.record({
  contextId: result.context_id,
  messageId: result.message_id,
  from: self,
  text: parts.text,
  sentAt: Date.now(),
  peers: uniquePeers,
});

return {
  context_id: result.context_id,
  message_id: result.message_id,
  results: result.results,
};
```

Delete the block at `channel.ts:170–172` that stamps `participants = [self, ...peers]`. Participants stamping is now the daemon's job.

- [ ] **Step 3: Update tests**

Update `adapters/claude-code/test/channel.test.ts` to assert the new `send` output shape (`{context_id, message_id, results: [{peer, delivery}]}`) and that `addressed_to` / `in_reply_to` pass through.

- [ ] **Step 4: Run tests**

```bash
pnpm -C adapters/claude-code test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/src/channel.ts adapters/claude-code/test/channel.test.ts
git commit -m "feat(adapter): send accepts addressed_to + in_reply_to

Tool input schema extended. Participants stamping removed from
adapter (now done by daemon). Response shape carries the shared
message_id at top level and per-peer delivery outcome."
```

---

### Task 11: `thread-store.ts` — shared messageId handling

**Files:**
- Modify: `adapters/claude-code/src/thread-store.ts`
- Test: `adapters/claude-code/test/thread-store.test.ts`

- [ ] **Step 1: Audit current storage**

```bash
sed -n '1,120p' adapters/claude-code/src/thread-store.ts
```

Today, each fanout leg gets its own messageId stored. With the shared messageId, one outbound `send` results in **one** record (not N).

- [ ] **Step 2: Update `record()` to take a `peers: string[]` and store once**

Replace any call sites that store per-leg. The signature should be:

```typescript
record(entry: {
  contextId: string;
  messageId: string;          // shared across all recipients
  from: string;               // sender handle (self for outbound)
  text: string;
  sentAt: number;
  peers: string[];            // recipient handles
  direction?: "outbound" | "inbound";
}): void
```

- [ ] **Step 3: Update `list_threads` / `thread_history` projections**

A thread's `peers` becomes the union of all recorded `peers` arrays plus `from`. Message counts reflect unique shared messageIds, not per-leg records.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm -C adapters/claude-code test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/src/thread-store.ts adapters/claude-code/test/thread-store.test.ts
git commit -m "refactor(adapter): thread-store keyed by shared message_id

Outbound sends store once, not per-leg. list_threads and
thread_history reflect logical messages instead of fanout legs."
```

---

### Task 12: `channel.ts` — render new `<channel>` tag attributes

**Files:**
- Modify: `adapters/claude-code/src/channel.ts` (around lines 376–388, the MCP notification serializer)
- Test: `adapters/claude-code/test/channel.test.ts`

- [ ] **Step 1: Extend the channel-tag renderer**

Current code at `channel.ts:376–388` renders `peer`, `context_id`, `task_id`, `message_id`, and (when multi-party) `participants`. Extend to render `self`, `addressed_to`, `in_reply_to` from `message.metadata`:

```typescript
const meta = incoming.metadata ?? {};
const attrs: Record<string, string> = {
  source: "tidepool",
  peer: meta.from ?? "unknown",
  context_id: incoming.contextId ?? "",
  task_id: incoming.messageId ?? "",
  message_id: incoming.messageId ?? "",
};

// Always stamp self when the daemon set it
if (typeof meta.self === "string") attrs.self = meta.self;

// Multi-party: space-separated participants
if (Array.isArray(meta.participants) && meta.participants.length > 1) {
  attrs.participants = meta.participants.join(" ");
}

// Optional addressed_to (space-separated)
if (Array.isArray(meta.addressed_to) && meta.addressed_to.length > 0) {
  attrs.addressed_to = meta.addressed_to.join(" ");
}

// Optional in_reply_to
if (typeof meta.in_reply_to === "string") attrs.in_reply_to = meta.in_reply_to;

// Serialize <channel ...> tag from attrs
```

- [ ] **Step 2: Add renderer test**

In `adapters/claude-code/test/channel.test.ts`:

```typescript
import { renderChannelTag } from "../src/channel.js"; // export it if it isn't already

describe("channel tag rendering", () => {
  it("renders self always, and addressed_to / in_reply_to when present", () => {
    const out = renderChannelTag({
      messageId: "M",
      contextId: "C",
      parts: [{ kind: "text", text: "body" }],
      metadata: {
        from: "mongoose",
        self: "fox",
        participants: ["fox", "marmot", "mongoose"],
        addressed_to: ["fox"],
        in_reply_to: "M7",
      },
    });
    expect(out).toContain('self="fox"');
    expect(out).toContain('addressed_to="fox"');
    expect(out).toContain('in_reply_to="M7"');
    expect(out).toContain('participants="fox marmot mongoose"');
  });

  it("omits optional fields when absent", () => {
    const out = renderChannelTag({
      messageId: "M",
      contextId: "C",
      parts: [{ kind: "text", text: "body" }],
      metadata: { from: "alice", self: "bob" }, // pairwise
    });
    expect(out).toContain('self="bob"');
    expect(out).not.toContain("participants=");
    expect(out).not.toContain("addressed_to=");
    expect(out).not.toContain("in_reply_to=");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm -C adapters/claude-code test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add adapters/claude-code/src/channel.ts adapters/claude-code/test/channel.test.ts
git commit -m "feat(adapter): render self/addressed_to/in_reply_to on channel tag

self is always present on inbound (receiver projection, stamped by
daemon). addressed_to and in_reply_to appear only when set."
```

---

## Phase 5 — P0 end-to-end

### Task 13: e2e — three-peer scenario

**Files:**
- Create: `test/e2e-multi-party-envelope.test.ts`

Replay the audit scenario (mongoose, fox, marmot) over real daemons.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e-multi-party-envelope.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startThreePeerFixture } from "./helpers/three-peers.js"; // create this helper following existing e2e patterns

describe("e2e — multi-party envelope (P0)", () => {
  let fx: Awaited<ReturnType<typeof startThreePeerFixture>>;
  beforeEach(async () => { fx = await startThreePeerFixture(); });
  afterEach(async () => { await fx.stop(); });

  it("each receiver sees their own handle as self", async () => {
    const { foxInbox, marmotInbox } = await fx.mongooseSends({
      to: ["fox", "marmot"], text: "hello both",
    });
    expect(foxInbox[0].metadata.self).toBe("fox");
    expect(marmotInbox[0].metadata.self).toBe("marmot");
  });

  it("addressed_to is consistent across all recipients' envelopes", async () => {
    const { foxInbox, marmotInbox } = await fx.mongooseSends({
      to: ["fox", "marmot"], text: "fox — what triggers it?",
      addressed_to: ["fox"],
    });
    expect(foxInbox[0].metadata.addressed_to).toEqual(["fox"]);
    expect(marmotInbox[0].metadata.addressed_to).toEqual(["fox"]);
  });

  it("shared message_id across fanout legs", async () => {
    const { sendResult, foxInbox, marmotInbox } = await fx.mongooseSends({
      to: ["fox", "marmot"], text: "broadcast",
    });
    expect(foxInbox[0].messageId).toBe(sendResult.message_id);
    expect(marmotInbox[0].messageId).toBe(sendResult.message_id);
  });

  it("rejects addressed_to containing a non-peer handle", async () => {
    await expect(fx.mongooseSends({
      to: ["fox", "marmot"], text: "x", addressed_to: ["ghost"],
    })).rejects.toMatchObject({ status: 400 });
  });
});
```

If `test/helpers/three-peers.ts` doesn't exist, build it following the patterns in any existing `test/e2e-*.test.ts`. Do not invent a new helper layer.

- [ ] **Step 2: Run**

```bash
pnpm vitest run test/e2e-multi-party-envelope.test.ts
```

Expected: all four pass.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-multi-party-envelope.test.ts test/helpers/three-peers.ts
git commit -m "test(e2e): three-peer envelope scenarios (P0)

Replays the audit's key cases: self correctness per recipient,
addressed_to consistency, shared message_id, rejection of
non-peer addressed_to."
```

---

## Phase 6 — P1 end-to-end

### Task 14: e2e — `in_reply_to` correlation + parallel replies

**Files:**
- Modify: `test/e2e-multi-party-envelope.test.ts`

- [ ] **Step 1: Add cases**

```typescript
describe("e2e — in_reply_to (P1)", () => {
  let fx: Awaited<ReturnType<typeof startThreePeerFixture>>;
  beforeEach(async () => { fx = await startThreePeerFixture(); });
  afterEach(async () => { await fx.stop(); });

  it("parallel replies to the same message succeed independently", async () => {
    const { sendResult: m } = await fx.mongooseSends({
      to: ["fox", "marmot"], text: "question",
    });
    const [foxReply, marmotReply] = await Promise.all([
      fx.foxSends({ to: ["mongoose", "marmot"], text: "fox answer", in_reply_to: m.message_id }),
      fx.marmotSends({ to: ["mongoose", "fox"], text: "marmot answer", in_reply_to: m.message_id }),
    ]);
    expect(foxReply.sendResult.message_id).not.toBe(marmotReply.sendResult.message_id);
    // Neither reply references the other
    expect(foxReply.outboundMetadata.in_reply_to).toBe(m.message_id);
    expect(marmotReply.outboundMetadata.in_reply_to).toBe(m.message_id);
  });

  it("rejects in_reply_to referencing a message from a different thread", async () => {
    const { sendResult: m } = await fx.mongooseSends({ to: ["fox"], text: "t1" });
    // Start fresh thread (no `thread` arg) and try to reply to M.
    await expect(fx.mongooseSends({
      to: ["fox"], text: "t2", in_reply_to: m.message_id,
    })).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run**

```bash
pnpm vitest run test/e2e-multi-party-envelope.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-multi-party-envelope.test.ts
git commit -m "test(e2e): in_reply_to correlation and cross-thread rejection (P1)"
```

---

## Phase 7 — P2 end-to-end

### Task 15: e2e — delivery accepted vs failed

**Files:**
- Modify: `test/e2e-multi-party-envelope.test.ts`

- [ ] **Step 1: Add cases**

```typescript
describe("e2e — delivery acks (P2)", () => {
  let fx: Awaited<ReturnType<typeof startThreePeerFixture>>;
  beforeEach(async () => { fx = await startThreePeerFixture(); });
  afterEach(async () => { await fx.stop(); });

  it("reports delivery=accepted for online peers who never reply", async () => {
    // Silent fox never replies; still counts as delivered.
    const { sendResult } = await fx.mongooseSends({
      to: ["fox"], text: "silent treatment?",
    });
    expect(sendResult.results).toEqual([
      { peer: "fox", delivery: "accepted" },
    ]);
  });

  it("reports delivery=failed when a peer is unreachable", async () => {
    await fx.stopPeer("marmot"); // take marmot's daemon offline
    const { sendResult } = await fx.mongooseSends({
      to: ["fox", "marmot"], text: "one up one down",
    });
    const fox = sendResult.results.find((r) => r.peer === "fox");
    const marmot = sendResult.results.find((r) => r.peer === "marmot");
    expect(fox?.delivery).toBe("accepted");
    expect(marmot?.delivery).toBe("failed");
    expect(marmot?.reason?.kind).toMatch(/peer-unreachable|peer-not-registered|other/);
  });
});
```

- [ ] **Step 2: Run**

```bash
pnpm vitest run test/e2e-multi-party-envelope.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-multi-party-envelope.test.ts
git commit -m "test(e2e): delivery=accepted for silent peers, failed for offline (P2)"
```

---

## Phase 8 — Docs + cleanup

### Task 16: Update `docs/architecture.md`

**Files:**
- Modify: `docs/architecture.md` — §4 (middleware pipeline) and §6 (protocol surface)
- Modify: `docs/architecture.md` — §8 (roadmap)

- [ ] **Step 1: Update the protocol surface table (§6)**

Add a row for `POST /message:broadcast` (local plane only), describing inputs and outputs. Cross-link to the spec.

- [ ] **Step 2: Update the middleware / stamping sequence (§4)**

Add the new inbound stamping steps: `self` injection, `participants` re-projection (DID → handle), `addressed_to` re-projection, and `thread-index.record`.

- [ ] **Step 3: Add the extension to the extensions inventory**

Wherever extensions are listed (or add the subsection if it doesn't exist), note `tidepool/multi-party-envelope/v1` as optional.

- [ ] **Step 4: Update §8 (roadmap)**

Mark "P0–P2 envelope improvements" as complete when this plan merges. Add an open row for "P3: thread-canonical participants + reply_all" referencing the spec.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(arch): document multi-party envelope v1

Updates §4 (inbound middleware stamping), §6 (POST /message:broadcast
protocol surface + extension inventory), and §8 (P0–P2 complete;
P3 open)."
```

---

### Task 17: Add `tasks/` entry for P3 follow-up

**Files:**
- Create: `tasks/11-thread-canonical-participants.md`

- [ ] **Step 1: Write the follow-up task brief**

```markdown
# Task 11: Thread-canonical participants + reply_all (P3)

**Status:** Deferred from [multi-party envelope v1 spec](../docs/superpowers/specs/2026-04-17-multi-party-envelope-design.md)

**Why deferred:** Requires daemon-side thread state (participants per context_id, participants_changed events, cross-daemon coordination on membership changes). The audit ranked this lowest-friction and it should get its own design pass.

**Scope:**

- Promote per-thread participant list to daemon state.
- Emit `<channel kind="participants_changed" ...>` events on membership changes.
- Add `reply_all: true` shortcut on `message:broadcast` that resolves to current thread participants minus self.
- Decide authoritative-daemon-per-thread vs gossip model.
- Decide persistence semantics (ephemeral, disk-backed, replayable).

**Dependencies:** multi-party envelope v1 shipped (this current plan).
```

- [ ] **Step 2: Commit**

```bash
git add tasks/11-thread-canonical-participants.md
git commit -m "docs(tasks): open P3 follow-up for thread-canonical participants"
```

---

### Task 18: Smoke test + typecheck + full suite

**Files:** none

- [ ] **Step 1: Full typecheck**

```bash
pnpm typecheck
```

Expected: clean across workspace.

- [ ] **Step 2: Full test suite**

```bash
pnpm test:all
```

Expected: green, including new e2e tests.

- [ ] **Step 3: Smoke test**

```bash
pnpm smoke
```

Expected: green. If `scripts/smoke.ts` currently does a two-peer test only, extend it with a three-peer variant that exercises `self`, `addressed_to`, and shared `message_id`. Commit the smoke update separately if so.

- [ ] **Step 4: Final commit, if anything lingering**

```bash
git status
```

Expected: clean. If there are straggler files (e.g., a smoke script update), commit them now with an appropriate message.

---

### Task 19: Mixed-peer degradation check (manual)

**Files:** none (manual validation)

- [ ] **Step 1: Build a pre-change daemon from a sibling checkout**

```bash
git worktree add ../clawconnect-pre-v1 main
pnpm -C ../clawconnect-pre-v1 install
pnpm -C ../clawconnect-pre-v1 build
```

- [ ] **Step 2: Run a mixed pair**

Start the pre-v1 daemon on one peer and the post-change daemon on another. Use `pnpm dev` or the CLI for each, with a fixture configuring them as peers. Send messages in both directions.

- [ ] **Step 3: Verify degradation**

- Pre-change peer → post-change peer: post-change peer renders `<channel>` without `self`/`addressed_to`/`in_reply_to` (pre-change peer didn't stamp them). `participants` on the adapter tag falls back to whatever the pre-change peer sent (sender-projection string). Prose coordination still works.
- Post-change peer → pre-change peer: pre-change peer ignores unknown `metadata` fields. Its adapter renders the inbound without the new attributes. Agent still receives the text.

- [ ] **Step 4: Clean up**

```bash
git worktree remove ../clawconnect-pre-v1
```

- [ ] **Step 5: Document findings**

If any degradation issue surfaced (not purely ignore-unknown), open a GitHub issue or add a note to `tasks/11-thread-canonical-participants.md` for the rollout section.

---

## Rollout checklist (post-merge, pre-announce)

Not code; governance.

- [ ] Survey openclaw and any other A2A-compatible implementations for extension compatibility. Confirm they degrade correctly (ignore unknown metadata, accept standard A2A send; they don't speak our broadcast endpoint — that's local-plane-only so it's invisible to them).
- [ ] Update user-facing docs (`README.md` → quickstart if anything about `send`'s response shape is documented externally).
- [ ] If needed, ship a minor version bump of `@jellypod/tidepool-claude-code` since its `send` response shape changed.

---

## Self-review notes

**Spec coverage:** all four priority-ranked items in the spec are mapped — P0 (Tasks 5–8, 12, 13), P1 (Tasks 2, 7, 8, 14), P2 (Tasks 5, 15), infra prerequisites (Tasks 1, 3, 4, 6, 9–11), docs (Tasks 16–18).

**Known gap (deliberate):** This plan does not implement P3 (thread-canonical participants, reply_all, participants_changed events). Task 17 opens a follow-up.

**Type consistency:** `AgentDid` type (Task 1), `BroadcastRequest`/`BroadcastResponse` (Task 5), `TidepoolMetadataSchema` (Task 4) are used consistently across daemon and adapter tasks. `threadIndex` is the shared instance name.

**Migration safety:** Every change is backwards-compatible on the wire (unknown metadata is ignored by old peers). Adapter breaking change is local: `send` response shape changes; adapter major-version-bump on release.
