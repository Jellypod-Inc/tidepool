# Multi-Peer Send (B+) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent send one message to multiple peers in a single `send` call, sharing one `context_id` and carrying a `participants` list in `message.metadata`, so multi-party conversations become a protocol-level convention rather than a manual relay pattern.

**Architecture:** Adapter-only change. The claw-connect daemon stays dumb: it already preserves caller-supplied `message.metadata` via `injectMetadataFrom`, and it already accepts one message per POST to `/:tenant/message:send`. The adapter fans out N POSTs under one minted `contextId`, stamping every outbound with `message.metadata.participants = [self, ...peers]`. On the receive side, the adapter reads `participants` from the inbound message's metadata, unions them into the thread-store, and surfaces them as a `participants` attribute on the `<channel source="claw-connect">` event so Claude can choose to reply-all, reply-to-one, or branch off.

**Clean break — no back-compat.** Nothing has shipped. The `send` MCP tool signature changes from `{peer, text, thread?}` to `{peers: string[], text, thread?}`. The `thread-store` record's `peer: string` field becomes `peers: Set<string>`. `list_threads` output becomes `peers: string[]`. `sendOutbound` drops its responsibility for minting `contextId` — the caller (channel.ts) now owns that so fan-out shares one id.

**Tech Stack:** TypeScript, Zod (schemas), Vitest (tests), Node 20, MCP SDK (`@modelcontextprotocol/sdk`), Express (inbound HTTP), pnpm workspace. Only `packages/a2a-claude-code-adapter/` is modified.

---

## File Structure

**Modified files (all in `packages/a2a-claude-code-adapter/`):**

| File | Responsibility | Why it changes |
|---|---|---|
| `src/thread-store.ts` | In-memory record of threads keyed by contextId. | `peer: string` → `peers: Set<string>`; `RecordArgs` takes `peers: string[]`; `ThreadSummary` returns `peers: string[]` sorted. |
| `src/outbound.ts` | HTTP POST to daemon for one recipient. | Accept `contextId: string` (required, caller-minted) and `participants?: string[]` (embedded as `message.metadata.participants` when present). Return value drops `contextId` since the caller supplied it. |
| `src/http.ts` | Inbound HTTP server on adapter's `localEndpoint` port. | Read `message.metadata.participants` as `string[]` if present. Extend `InboundInfo` with `participants: string[]` (defaults to `[peer]` when absent). |
| `src/channel.ts` | MCP tools (`send`, `list_threads`, etc.) and inbound notification. | `send` tool takes `peers: string[]`. Handler mints one `contextId`, computes `participants = [self, ...peers]`, fans out per peer, records to store once, returns `{context_id, results: [{peer, message_id?, error?}]}`. `list_threads` returns `peers: string[]`. `notifyInbound` adds `participants` string (space-separated) to the notification `meta`. `INSTRUCTIONS` text updated for multi-peer convention. |
| `src/start.ts` | Wires channel → outbound → http. | One-line change: `send` callback passes `contextId` and `participants` through. |
| `test/thread-store.test.ts` | Thread-store unit tests. | Updated to new `peers`-based API. Add multi-peer coverage. |
| `test/channel.test.ts` | Channel (MCP tools + notify) unit tests. | Updated to new `peers` input/output. Add multi-peer fan-out tests and participants-metadata tests. |
| `test/outbound.test.ts` | Outbound HTTP unit tests. | Updated to new `contextId`-required API; add participants-metadata test. |
| `test/http.test.ts` | Inbound HTTP unit tests. | Add participants-metadata parsing test. |
| `test/integration.test.ts` | End-to-end two-agent round-trip via mock relay. | Update pairwise call to new `peers: ["bob"]` shape. |
| `test/three-agent.test.ts` (NEW) | End-to-end three-agent fan-out. | Alice sends to [bob, carol]; verify shared contextId, participants delivered, reply-all works. |
| `README.md` | User-facing docs. | New "Multi-peer conversations" section describing the convention. |

**Unchanged:** `packages/claw-connect/*` (daemon side — `injectMetadataFrom` already preserves `metadata.participants`). `src/version.ts`, `src/config.ts`, `src/bin/*`.

---

## Sanity checks before coding

These are facts the implementation depends on. Confirm they haven't drifted before Task 1:

1. `packages/claw-connect/src/identity-injection.ts:16` spreads existing metadata: `message.metadata = { ...existingMetadata, from: handle };`. This means `participants` set by the sender survives the daemon hop. **If this changed, stop and re-plan.**
2. `packages/claw-connect/src/a2a.ts:187-197` — `MessageSchema` uses `.loose()` on the outer Message and `z.record(z.string(), z.unknown()).optional()` on metadata. Extra metadata keys pass validation. **If this tightened to strict, stop and re-plan.**
3. `packages/a2a-claude-code-adapter/test/integration.test.ts:33-39` — mock relay reconstructs body with `metadata: { ...existing, from: sender }`. This matches real daemon behavior. Tests should keep passing under the new code.

---

## Task 1: Refactor thread-store to multi-peer

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/thread-store.ts` (whole file)
- Modify: `packages/a2a-claude-code-adapter/test/thread-store.test.ts` (whole file)

- [ ] **Step 1: Update the test file to the new API.** Replace the contents of `test/thread-store.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { createThreadStore } from "../src/thread-store.js";

describe("createThreadStore", () => {
  it("records a pairwise message and lists the thread with one peer", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({
      contextId: "C1",
      peers: ["bob"],
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const threads = s.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      contextId: "C1",
      peers: ["bob"],
      lastMessageAt: 1000,
      messageCount: 1,
    });
  });

  it("records a multi-peer message and unions peers on subsequent events", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({
      contextId: "C1",
      peers: ["bob", "carol"],
      messageId: "M1",
      from: "alice",
      text: "hi all",
      sentAt: 1000,
    });
    s.record({
      contextId: "C1",
      peers: ["alice", "carol"],
      messageId: "M2",
      from: "bob",
      text: "hey",
      sentAt: 2000,
    });
    const threads = s.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].peers).toEqual(["alice", "bob", "carol"]);
    expect(threads[0].messageCount).toBe(2);
  });

  it("threads are returned newest-last-activity first", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peers: ["carol"], messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    const threads = s.listThreads();
    expect(threads.map((t) => t.contextId)).toEqual(["C2", "C1"]);
  });

  it("filters threads by peer membership (single-peer thread)", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peers: ["carol"], messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    expect(s.listThreads({ peer: "bob" })).toHaveLength(1);
    expect(s.listThreads({ peer: "bob" })[0].contextId).toBe("C1");
  });

  it("filters threads by peer membership (multi-peer thread matches any member)", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["bob", "carol"], messageId: "M1", from: "alice", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peers: ["dave"], messageId: "M2", from: "dave", text: "b", sentAt: 2000 });
    expect(s.listThreads({ peer: "carol" }).map((t) => t.contextId)).toEqual(["C1"]);
    expect(s.listThreads({ peer: "dave" }).map((t) => t.contextId)).toEqual(["C2"]);
  });

  it("returns thread history in chronological order", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M1", from: "bob", text: "first", sentAt: 1000 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M2", from: "alice", text: "second", sentAt: 2000 });
    const history = s.history("C1");
    expect(history.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("evicts oldest messages when per-thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 2, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peers: ["bob"],
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const history = s.history("C1");
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("evicts oldest thread (by last_activity) when thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 2 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peers: ["carol"], messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peers: ["dave"], messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    const ctxs = s.listThreads().map((t) => t.contextId);
    expect(ctxs).toEqual(["C3", "C2"]);
    expect(s.history("C1")).toEqual([]);
  });

  it("history with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peers: ["bob"],
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const last2 = s.history("C1", { limit: 2 });
    expect(last2.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("listThreads with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peers: ["carol"], messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peers: ["dave"], messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    expect(s.listThreads({ limit: 2 }).map((t) => t.contextId)).toEqual(["C3", "C2"]);
  });

  it("history of unknown thread returns empty array", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    expect(s.history("nonexistent")).toEqual([]);
  });

  it("peers list is sorted and deduplicated in ThreadSummary", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peers: ["carol", "bob"], messageId: "M1", from: "alice", text: "a", sentAt: 1000 });
    s.record({ contextId: "C1", peers: ["bob"], messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    expect(s.listThreads()[0].peers).toEqual(["bob", "carol"]);
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails with the current thread-store.**

Run: `pnpm --filter a2a-claude-code-adapter test thread-store`
Expected: Tests fail — current API takes `peer: string`, not `peers: string[]`. Type errors in test file.

- [ ] **Step 3: Rewrite `src/thread-store.ts` to the new API.** Replace the whole file with:

```typescript
export type StoredMessage = {
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

export type ThreadSummary = {
  contextId: string;
  peers: string[];
  lastMessageAt: number;
  messageCount: number;
};

export type ThreadStoreOpts = {
  maxMessagesPerThread: number;
  maxThreads: number;
};

export type RecordArgs = {
  contextId: string;
  peers: string[];
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

type ThreadRecord = {
  peers: Set<string>;
  lastActivity: number;
  messages: StoredMessage[];
};

export type ThreadStore = {
  record(args: RecordArgs): void;
  listThreads(opts?: { peer?: string; limit?: number }): ThreadSummary[];
  history(contextId: string, opts?: { limit?: number }): StoredMessage[];
};

export function createThreadStore(opts: ThreadStoreOpts): ThreadStore {
  const threads = new Map<string, ThreadRecord>();
  let hasLoggedEviction = false;

  function evictIfFull() {
    while (threads.size > opts.maxThreads) {
      let oldestKey: string | undefined;
      let oldestActivity = Infinity;
      for (const [k, v] of threads) {
        if (v.lastActivity < oldestActivity) {
          oldestActivity = v.lastActivity;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      threads.delete(oldestKey);
      if (!hasLoggedEviction) {
        hasLoggedEviction = true;
        process.stderr.write(
          `[claw-connect-adapter] thread store at maxThreads=${opts.maxThreads} — evicting oldest by last_activity. Further evictions are silent.\n`,
        );
      }
    }
  }

  return {
    record(args) {
      let t = threads.get(args.contextId);
      if (!t) {
        t = { peers: new Set(), lastActivity: args.sentAt, messages: [] };
        threads.set(args.contextId, t);
      }
      for (const p of args.peers) t.peers.add(p);
      t.lastActivity = args.sentAt;
      t.messages.push({
        messageId: args.messageId,
        from: args.from,
        text: args.text,
        sentAt: args.sentAt,
      });
      if (t.messages.length > opts.maxMessagesPerThread) {
        t.messages.splice(0, t.messages.length - opts.maxMessagesPerThread);
      }
      evictIfFull();
    },

    listThreads(listOpts) {
      let summaries: ThreadSummary[] = [];
      for (const [contextId, t] of threads) {
        if (listOpts?.peer && !t.peers.has(listOpts.peer)) continue;
        summaries.push({
          contextId,
          peers: [...t.peers].sort(),
          lastMessageAt: t.lastActivity,
          messageCount: t.messages.length,
        });
      }
      summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      if (listOpts?.limit !== undefined) {
        summaries = summaries.slice(0, listOpts.limit);
      }
      return summaries;
    },

    history(contextId, historyOpts) {
      const t = threads.get(contextId);
      if (!t) return [];
      const all = t.messages;
      if (historyOpts?.limit !== undefined) {
        return all.slice(-historyOpts.limit);
      }
      return [...all];
    },
  };
}
```

- [ ] **Step 4: Run tests to verify thread-store passes.**

Run: `pnpm --filter a2a-claude-code-adapter test thread-store`
Expected: all 11 tests PASS.

- [ ] **Step 5: Commit.**

```bash
cd /Users/piersonmarks/src/tries/2026-04-13-clawconnect
git add packages/a2a-claude-code-adapter/src/thread-store.ts packages/a2a-claude-code-adapter/test/thread-store.test.ts
git commit -m "feat(adapter): thread-store peers as a set

Replace ThreadRecord.peer: string with peers: Set<string>. RecordArgs.peers
is an array unioned on each record. listThreads filter matches on peer
membership. ThreadSummary emits a sorted peers array.

Enables multi-peer threads under shared context_id."
```

---

## Task 2: Refactor `sendOutbound` to caller-owned contextId and optional participants

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/outbound.ts`
- Modify: `packages/a2a-claude-code-adapter/test/outbound.test.ts`

- [ ] **Step 1: Read existing outbound tests to preserve their intent.**

Run: `cat packages/a2a-claude-code-adapter/test/outbound.test.ts`

Keep all the error-path behaviors (daemon-down, peer-not-registered, peer-unreachable, other). Only the argument shape and return value change.

- [ ] **Step 2: Rewrite `src/outbound.ts`.** Replace the whole file with:

```typescript
import { randomUUID } from "node:crypto";

export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
};

export type SendErrorKind =
  | "daemon-down"
  | "peer-not-registered"
  | "peer-unreachable"
  | "other";

export class SendError extends Error {
  readonly kind: SendErrorKind;
  readonly hint: string;
  constructor(kind: SendErrorKind, message: string, hint: string) {
    super(message);
    this.name = "SendError";
    this.kind = kind;
    this.hint = hint;
  }
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|connection refused/i.test(msg);
}

/**
 * POST one message to one peer via the claw-connect daemon's local proxy.
 *
 * The caller (channel.ts) owns contextId minting so a fan-out to N peers
 * shares one id. When `participants` is supplied (length >= 2 by convention),
 * it rides on message.metadata.participants and is preserved by the daemon's
 * metadata injection — receivers read it to know who else is in the thread.
 *
 * Returns {messageId} on success. Throws SendError on failure.
 */
export async function sendOutbound(args: {
  peer: string;
  contextId: string;
  text: string;
  self: string;
  participants?: string[];
  deps: OutboundDeps;
}): Promise<{ messageId: string }> {
  const { peer, contextId, text, self, participants, deps } = args;
  const messageId = randomUUID();
  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;

  const message: {
    messageId: string;
    contextId: string;
    parts: Array<{ kind: "text"; text: string }>;
    metadata?: { participants: string[] };
  } = {
    messageId,
    contextId,
    parts: [{ kind: "text", text }],
  };
  if (participants && participants.length > 0) {
    message.metadata = { participants };
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent": self,
      },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw new SendError(
        "daemon-down",
        "the claw-connect daemon isn't running",
        "Ask the user to run `claw-connect claude-code:start` (or `claw-connect serve &`) and retry.",
      );
    }
    throw new SendError(
      "other",
      err instanceof Error ? err.message : String(err),
      "Ask the user to check `claw-connect status` and the daemon log at ~/.config/claw-connect/logs/.",
    );
  }

  if (res.status === 403 || res.status === 404) {
    throw new SendError(
      "peer-not-registered",
      `no agent named "${peer}" is registered`,
      "Call list_peers to see who's reachable. If the peer should exist, ask the user to confirm their session is running.",
    );
  }
  if (res.status === 504) {
    throw new SendError(
      "peer-unreachable",
      `"${peer}" is registered but didn't respond`,
      `Check that "${peer}"'s session is still running.`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SendError(
      "other",
      `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      "Ask the user to check `claw-connect status` and the daemon log.",
    );
  }

  // randomUUID is imported to preserve the pattern used elsewhere; keep the
  // import alive even if we ever stop minting messageId here.
  void randomUUID;

  return { messageId };
}
```

Note: the `void randomUUID` line is a lint guard — remove it if your linter doesn't warn on unused imports. `randomUUID` IS used above (line `const messageId = randomUUID();`), so simply delete the `void randomUUID;` line.

- [ ] **Step 3: Update `test/outbound.test.ts`.** Open the file and:
  - Replace every call site that passes `{peer, text, self, thread, deps}` with `{peer, contextId: "C-test", text, self, deps}` (invent any contextId string; the outbound doesn't mint one any more).
  - Replace every assertion of the return shape `.toMatchObject({contextId, messageId})` with `.toMatchObject({messageId})`.
  - Add one new test at the end of the file:

```typescript
it("embeds message.metadata.participants when participants is supplied", async () => {
  let captured: any;
  const fetchImpl = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ id: "T1", contextId: "C1", status: { state: "completed" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  await sendOutbound({
    peer: "bob",
    contextId: "C1",
    text: "hi all",
    self: "alice",
    participants: ["alice", "bob", "carol"],
    deps: { localPort: 9901, fetchImpl },
  });
  expect(captured.message.metadata).toEqual({
    participants: ["alice", "bob", "carol"],
  });
});

it("omits message.metadata when participants is not supplied", async () => {
  let captured: any;
  const fetchImpl = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ id: "T1", contextId: "C1", status: { state: "completed" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  await sendOutbound({
    peer: "bob",
    contextId: "C1",
    text: "hi",
    self: "alice",
    deps: { localPort: 9901, fetchImpl },
  });
  expect(captured.message).not.toHaveProperty("metadata");
});
```

- [ ] **Step 4: Run outbound tests.**

Run: `pnpm --filter a2a-claude-code-adapter test outbound`
Expected: all outbound tests PASS (existing error-path tests unchanged in intent; two new participants tests pass).

- [ ] **Step 5: Commit.**

```bash
git add packages/a2a-claude-code-adapter/src/outbound.ts packages/a2a-claude-code-adapter/test/outbound.test.ts
git commit -m "refactor(adapter): caller-owned contextId in sendOutbound; add participants metadata

sendOutbound no longer mints contextId — the caller supplies it. This lets
channel.ts fan out one send() call to N peers under a single shared
context_id. When participants is supplied, it rides on message.metadata
and is preserved by the daemon for the receiving adapter."
```

---

## Task 3: Parse `participants` from inbound message metadata

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/http.ts`
- Modify: `packages/a2a-claude-code-adapter/test/http.test.ts`

- [ ] **Step 1: Add failing test.** Open `test/http.test.ts` and add after the existing tests:

```typescript
it("extracts participants array from message.metadata.participants", async () => {
  const received: InboundInfo[] = [];
  const h = await startHttp({
    port: 0,
    host: "127.0.0.1",
    onInbound: (info) => received.push(info),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi all" }],
          metadata: {
            from: "alice",
            participants: ["alice", "bob", "carol"],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].peer).toBe("alice");
    expect(received[0].participants).toEqual(["alice", "bob", "carol"]);
  } finally {
    await h.close();
  }
});

it("defaults participants to [peer] when metadata.participants is absent", async () => {
  const received: InboundInfo[] = [];
  const h = await startHttp({
    port: 0,
    host: "127.0.0.1",
    onInbound: (info) => received.push(info),
  });
  try {
    await fetch(`http://127.0.0.1:${h.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: { from: "bob" },
        },
      }),
    });
    expect(received[0].participants).toEqual(["bob"]);
  } finally {
    await h.close();
  }
});

it("ignores malformed participants (non-array or non-string entries)", async () => {
  const received: InboundInfo[] = [];
  const h = await startHttp({
    port: 0,
    host: "127.0.0.1",
    onInbound: (info) => received.push(info),
  });
  try {
    await fetch(`http://127.0.0.1:${h.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: { from: "bob", participants: "not-an-array" },
        },
      }),
    });
    expect(received[0].participants).toEqual(["bob"]);
  } finally {
    await h.close();
  }
});
```

You may need to add `import type { InboundInfo } from "../src/http.js";` at the top of the test file if it isn't already present.

- [ ] **Step 2: Run the new tests — they should fail.**

Run: `pnpm --filter a2a-claude-code-adapter test http`
Expected: new participants tests FAIL — `participants` is not yet a property on `InboundInfo`. TypeScript errors likely.

- [ ] **Step 3: Update `src/http.ts`.** Replace the whole file with:

```typescript
import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

export type InboundInfo = {
  taskId: string;
  contextId: string;
  messageId: string;
  peer: string;
  participants: string[];
  text: string;
};

export type StartHttpOpts = {
  port: number;
  host: string;
  onInbound: (info: InboundInfo) => void;
};

export const MAX_TEXT_BYTES = 64 * 1024;

function parseParticipants(raw: unknown, fallbackPeer: string): string[] {
  if (!Array.isArray(raw)) return [fallbackPeer];
  const clean = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (clean.length === 0) return [fallbackPeer];
  return clean;
}

export async function startHttp(opts: StartHttpOpts) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/message\\:send", async (req: Request, res: Response) => {
    const msg = req.body?.message;
    const textPart = msg?.parts?.[0]?.text;
    if (typeof textPart !== "string") {
      res.status(400).json({ error: "message.parts[0].text is required" });
      return;
    }
    if (Buffer.byteLength(textPart, "utf8") > MAX_TEXT_BYTES) {
      res
        .status(413)
        .json({ error: `message text exceeds ${MAX_TEXT_BYTES} byte limit` });
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
        text: textPart,
      });
    } catch (err) {
      process.stderr.write(
        `[claw-connect-adapter] onInbound threw: ${String(err)}\n`,
      );
    }

    res.json({
      id: taskId,
      contextId,
      status: { state: "completed" },
    });
  });

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Update any existing http tests that destructure `InboundInfo`** — they now need to accept `participants`. Run the full http test file and fix any type mismatches:

Run: `pnpm --filter a2a-claude-code-adapter test http`
Expected: existing tests may fail on missing `participants` property — add `participants: expect.any(Array)` or similar where relevant, or update expected objects to include `participants: ["<peer>"]`.

- [ ] **Step 5: All http tests pass.**

Run: `pnpm --filter a2a-claude-code-adapter test http`
Expected: all tests PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/a2a-claude-code-adapter/src/http.ts packages/a2a-claude-code-adapter/test/http.test.ts
git commit -m "feat(adapter): parse participants from inbound message.metadata

Inbound http extracts message.metadata.participants (array of strings) and
surfaces it on InboundInfo. Falls back to [peer] for pairwise messages
and malformed participants values."
```

---

## Task 4: Rewrite `send` MCP tool for multi-peer fan-out

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/channel.ts`
- Modify: `packages/a2a-claude-code-adapter/test/channel.test.ts`

This is the biggest change. Read the current `channel.ts` in full before editing so you can preserve all the non-send logic.

- [ ] **Step 1: Replace `src/channel.ts`.**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InboundInfo } from "./http.js";
import type { ThreadStore } from "./thread-store.js";
import { SendError } from "./outbound.js";
import { ADAPTER_VERSION } from "./version.js";

export type CreateChannelOpts = {
  self: string;
  store: ThreadStore;
  listPeers: () => string[];
  send: (args: {
    peer: string;
    contextId: string;
    text: string;
    participants?: string[];
  }) => Promise<{ messageId: string }>;
  serverName?: string;
};

export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const SendArgsSchema = z.object({
  peers: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  thread: z.string().optional(),
});

const ListThreadsArgsSchema = z.object({
  peer: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const ThreadHistoryArgsSchema = z.object({
  thread: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const INSTRUCTIONS =
  "This MCP server connects you to peer agents over the claw-connect network. " +
  "Inbound messages arrive as <channel source=\"claw-connect\" peer=\"...\" " +
  "participants=\"...\" context_id=\"...\" task_id=\"...\" message_id=\"...\"> " +
  "events. `peer` is the sender of that particular message; `participants` is " +
  "the full list of agents (including you) in the thread as the sender sees " +
  "it. To reply to one peer, call `send` with `peers: [\"<peer>\"]` and " +
  "`thread=<context_id>`. To reply-all in a multi-party thread, pass every " +
  "other participant: `peers: <all participants except your own handle>`. " +
  "To start a new conversation, call `send` without `thread`; a fresh " +
  "context_id is minted. Multi-peer sends share one context_id and carry the " +
  "participant list to every recipient — there is no room, no join/leave, " +
  "no enforcement: it is a convention agents negotiate. Use `list_peers` " +
  "before sending; never guess handles. Use `list_threads` when interleaving " +
  "multiple peers, and `thread_history` to re-load context after a gap.";

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "claw-connect";
  const server = new Server(
    { name: serverName, version: ADAPTER_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send",
        description:
          "Send one message to one or more peers. Returns `{context_id, results: [{peer, message_id?, error?}]}` — a peer's reply (if any) arrives later as a separate <channel source=\"claw-connect\"> event with the same context_id. Pass `thread=<context_id>` to continue an existing conversation; omit to start a new one. Multi-peer sends share one context_id and stamp a participants list onto every outbound so receivers know who else is in the thread — recipients are free to reply-all, reply-to-one, or branch to a new thread. Always call `list_peers` before guessing handles.",
        inputSchema: {
          type: "object",
          properties: {
            peers: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description:
                "one or more peer handles from list_peers. Length 1 for pairwise; length 2+ for multi-party.",
            },
            text: { type: "string", description: "message text" },
            thread: {
              type: "string",
              description:
                "context_id to continue a thread; omit to start a new one",
            },
          },
          required: ["peers", "text"],
        },
      },
      {
        name: "whoami",
        description: "Return this agent's own handle on the claw-connect network.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_peers",
        description:
          "List handles of peers this agent can reach. Call before send; do not guess.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_threads",
        description:
          "List threads this agent is part of. A thread is identified by context_id and may have one or more peer participants. Use to triage when multiple peers are active. Optionally filter by peer (matches threads where that peer is any participant).",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "filter to threads that include this peer" },
            limit: { type: "number", description: "return at most N threads" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "thread_history",
        description:
          "Re-load messages from a thread you've been away from. Returns messages chronologically with sender and timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            thread: { type: "string", description: "context_id of the thread" },
            limit: {
              type: "number",
              description: "return at most N most-recent messages",
            },
          },
          required: ["thread"],
          additionalProperties: false,
        },
      },
    ],
  }));

  const handleSend = async (req: ToolCallRequest): Promise<ToolCallResult> => {
    const parsed = SendArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const { peers, text, thread } = parsed.data;
    // Dedupe peers in input order so fan-out doesn't double-send.
    const uniquePeers = Array.from(new Set(peers));
    const contextId = thread ?? randomUUID();
    const isMultiParty = uniquePeers.length > 1;
    const participants = isMultiParty
      ? [opts.self, ...uniquePeers]
      : undefined;

    type SendResult =
      | { peer: string; message_id: string }
      | {
          peer: string;
          error: { kind: string; message: string; hint: string };
        };
    const results: SendResult[] = [];
    const successfulPeers: string[] = [];
    let firstSuccessMessageId: string | undefined;

    for (const peer of uniquePeers) {
      try {
        const { messageId } = await opts.send({
          peer,
          contextId,
          text,
          participants,
        });
        results.push({ peer, message_id: messageId });
        successfulPeers.push(peer);
        if (!firstSuccessMessageId) firstSuccessMessageId = messageId;
      } catch (err) {
        if (err instanceof SendError) {
          results.push({
            peer,
            error: { kind: err.kind, message: err.message, hint: err.hint },
          });
        } else {
          throw err;
        }
      }
    }

    // Record one store entry per send tool call (not per peer) — thread-store
    // tracks the message once, peers union into the thread's member set. Use
    // the first successful message_id as the canonical id for the record.
    if (successfulPeers.length > 0 && firstSuccessMessageId) {
      opts.store.record({
        contextId,
        peers: successfulPeers,
        messageId: firstSuccessMessageId,
        from: opts.self,
        text,
        sentAt: Date.now(),
      });
    }

    const allFailed = results.every((r) => "error" in r);
    return {
      isError: allFailed ? true : undefined,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            context_id: contextId,
            results,
          }),
        },
      ],
    };
  };

  const handleWhoami = (): ToolCallResult => ({
    content: [{ type: "text", text: JSON.stringify({ handle: opts.self }) }],
  });

  const handleListPeers = (): ToolCallResult => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          peers: [...opts.listPeers()]
            .sort()
            .map((handle) => ({ handle })),
        }),
      },
    ],
  });

  const handleListThreads = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ListThreadsArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const summaries = opts.store.listThreads({
      peer: parsed.data.peer,
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            threads: summaries.map((s) => ({
              context_id: s.contextId,
              peers: s.peers,
              last_message_at: s.lastMessageAt,
              message_count: s.messageCount,
            })),
          }),
        },
      ],
    };
  };

  const handleThreadHistory = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ThreadHistoryArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const messages = opts.store.history(parsed.data.thread, {
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messages: messages.map((m) => ({
              message_id: m.messageId,
              from: m.from,
              text: m.text,
              sent_at: m.sentAt,
            })),
          }),
        },
      ],
    };
  };

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    switch (req.name) {
      case "send":
        return handleSend(req);
      case "whoami":
        return handleWhoami();
      case "list_peers":
        return handleListPeers();
      case "list_threads":
        return handleListThreads(req);
      case "thread_history":
        return handleThreadHistory(req);
      default:
        throw new Error(`unknown tool: ${req.name}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall({
      name: req.params.name,
      arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
    });
  });

  const notifyInbound = async (info: InboundInfo): Promise<void> => {
    // Non-self participants (the thread's other members, from the sender's view).
    const otherPeers = info.participants.filter((p) => p !== opts.self);
    opts.store.record({
      contextId: info.contextId,
      peers: otherPeers.length > 0 ? otherPeers : [info.peer],
      messageId: info.messageId,
      from: info.peer,
      text: info.text,
      sentAt: Date.now(),
    });

    // Surface participants on the channel block only when multi-party.
    const meta: Record<string, unknown> = {
      peer: info.peer,
      context_id: info.contextId,
      task_id: info.taskId,
      message_id: info.messageId,
    };
    if (info.participants.length > 1) {
      // Space-separated string — renders cleanly as a <channel …> attribute and
      // is trivial to split on the agent side.
      meta.participants = info.participants.join(" ");
    }

    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta,
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
```

- [ ] **Step 2: Rewrite `test/channel.test.ts`.** Replace the whole file with:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channel.js";
import { createThreadStore } from "../src/thread-store.js";
import { SendError } from "../src/outbound.js";

function setup(overrides?: {
  send?: (args: {
    peer: string;
    contextId: string;
    text: string;
    participants?: string[];
  }) => Promise<{ messageId: string }>;
  listPeers?: () => string[];
  self?: string;
}) {
  const store = createThreadStore({ maxMessagesPerThread: 100, maxThreads: 50 });
  const sent: any[] = [];
  let counter = 0;
  const ch = createChannel({
    self: overrides?.self ?? "alice",
    store,
    listPeers: overrides?.listPeers ?? (() => ["bob", "carol"]),
    send:
      overrides?.send ??
      (async (args) => {
        sent.push(args);
        counter++;
        return { messageId: `M-${counter}` };
      }),
  });
  return { ch, store, sent };
}

describe("channel notifyInbound", () => {
  it("emits notifications/claude/channel with pairwise meta (no participants attr)", async () => {
    const { ch, store } = setup();
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "T1",
      contextId: "C1",
      messageId: "M1",
      peer: "bob",
      participants: ["bob"],
      text: "hello",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello",
        meta: {
          peer: "bob",
          context_id: "C1",
          task_id: "T1",
          message_id: "M1",
        },
      },
    });
    expect(calls[0].params.meta.participants).toBeUndefined();
    expect(store.history("C1")).toHaveLength(1);
    expect(store.history("C1")[0]).toMatchObject({
      from: "bob",
      text: "hello",
      messageId: "M1",
    });
  });

  it("emits participants (space-separated) when multi-party", async () => {
    const { ch, store } = setup({ self: "wolverine" });
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "T1",
      contextId: "C1",
      messageId: "M1",
      peer: "alice",
      participants: ["alice", "wolverine", "bobby"],
      text: "hi all",
    });
    expect(calls[0].params.meta.participants).toBe("alice wolverine bobby");
    // Store records every non-self participant (alice, bobby).
    const summaries = store.listThreads();
    expect(summaries[0].peers).toEqual(["alice", "bobby"]);
  });
});

describe("channel tool dispatch — send", () => {
  it("pairwise: peers:[bob] mints a fresh context, posts once, no participants metadata", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.context_id).toBe("string");
    expect(data.context_id.length).toBeGreaterThan(0);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toEqual({ peer: "bob", message_id: "M-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe("bob");
    expect(sent[0].contextId).toBe(data.context_id);
    expect(sent[0].participants).toBeUndefined();
    expect(store.history(data.context_id)).toHaveLength(1);
    expect(store.history(data.context_id)[0]).toMatchObject({
      from: "alice",
      text: "hi",
    });
  });

  it("multi-peer: peers:[bob,carol] fans out under one contextId with participants [self,bob,carol]", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi all" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.results.map((r: any) => r.peer)).toEqual(["bob", "carol"]);
    expect(sent).toHaveLength(2);
    // Both sends share the same contextId.
    expect(sent[0].contextId).toBe(data.context_id);
    expect(sent[1].contextId).toBe(data.context_id);
    // Both sends carry the same participants list including self.
    expect(sent[0].participants).toEqual(["alice", "bob", "carol"]);
    expect(sent[1].participants).toEqual(["alice", "bob", "carol"]);
    // Thread store has one record with both peers.
    const summaries = store.listThreads();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].peers).toEqual(["bob", "carol"]);
    expect(summaries[0].messageCount).toBe(1);
  });

  it("send with thread reuses the supplied contextId", async () => {
    const { ch, sent } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "follow-up", thread: "ctx-existing" },
    });
    expect(sent[0].contextId).toBe("ctx-existing");
  });

  it("dedupes duplicate peers in the input", async () => {
    const { ch, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "bob", "carol"], text: "hi" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.peer).sort()).toEqual(["bob", "carol"]);
  });

  it("partial failure: one peer fails, others succeed — overall success with error in results", async () => {
    const sendFn = vi.fn(async ({ peer }: any) => {
      if (peer === "carol") {
        throw new SendError(
          "peer-not-registered",
          "no agent named \"carol\" is registered",
          "call list_peers",
        );
      }
      return { messageId: `M-${peer}` };
    });
    const { ch } = setup({ send: sendFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0]).toEqual({ peer: "bob", message_id: "M-bob" });
    expect(data.results[1].peer).toBe("carol");
    expect(data.results[1].error).toMatchObject({
      kind: "peer-not-registered",
      message: expect.stringContaining("carol"),
    });
  });

  it("all-failed: isError true; results contains one error per peer", async () => {
    const sendFn = vi.fn(async () => {
      throw new SendError("daemon-down", "daemon is down", "run serve");
    });
    const { ch } = setup({ send: sendFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.results.every((r: any) => r.error)).toBe(true);
  });

  it("rejects empty peers array", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: [], text: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/);
  });
});

describe("channel tool dispatch — other tools", () => {
  it("whoami returns the agent handle", async () => {
    const { ch } = setup({ self: "alice" });
    const result = await ch.handleToolCall({ name: "whoami", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ handle: "alice" });
  });

  it("list_peers returns sorted handle list", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "list_peers",
      arguments: {},
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      peers: [{ handle: "bob" }, { handle: "carol" }],
    });
  });

  it("list_threads returns peers as an array", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob", "carol"],
      messageId: "M1",
      from: "alice",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "list_threads",
      arguments: {},
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]).toMatchObject({
      context_id: "C1",
      peers: ["bob", "carol"],
      message_count: 1,
    });
  });

  it("list_threads filter by peer matches any participant", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob", "carol"],
      messageId: "M1",
      from: "alice",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "list_threads",
      arguments: { peer: "carol" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].context_id).toBe("C1");
  });

  it("thread_history returns message list", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob"],
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "thread_history",
      arguments: { thread: "C1" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      message_id: "M1",
      from: "bob",
      text: "hi",
      sent_at: 1000,
    });
  });

  it("unknown tool throws", async () => {
    const { ch } = setup();
    await expect(
      ch.handleToolCall({ name: "claw_connect_reply", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });
});
```

- [ ] **Step 3: Run channel tests.**

Run: `pnpm --filter a2a-claude-code-adapter test channel`
Expected: all tests PASS.

- [ ] **Step 4: Commit.**

```bash
git add packages/a2a-claude-code-adapter/src/channel.ts packages/a2a-claude-code-adapter/test/channel.test.ts
git commit -m "feat(adapter): multi-peer send with shared context_id and participants

- send tool now takes peers: string[] (1..N). One minted contextId is shared
  across the fan-out; for N>1, message.metadata.participants = [self, ...peers]
  rides every outbound.
- Partial failure is first-class: results is an array of {peer, message_id}
  or {peer, error}; isError only when every peer failed.
- notifyInbound emits participants as a space-separated string in meta when
  the inbound message is multi-party (>1 participant).
- list_threads returns peers as an array; filter by peer matches on membership.
- Thread store records one entry per send call; peers union into the thread's
  member set.

Breaking change — pairwise callers must now pass peers: [\"<peer>\"]."
```

---

## Task 5: Wire `start.ts` to the new `send` signature

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/start.ts`

- [ ] **Step 1: Update `src/start.ts`.** Only the `send:` callback inside `createChannel({ ... })` changes. Replace the whole file with:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  loadAgentConfig,
  loadProxyConfig,
  listPeerHandles,
} from "./config.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendOutbound } from "./outbound.js";
import { createThreadStore } from "./thread-store.js";

export type StartOpts = {
  configDir: string;
  agentName?: string;
  host?: string;
  maxMessagesPerThread?: number;
  maxThreads?: number;
  /** MCP transport for tests; defaults to stdio. */
  transport?: Transport;
};

export async function start(opts: StartOpts) {
  const host = opts.host ?? "127.0.0.1";

  const agent = loadAgentConfig(opts.configDir, opts.agentName);
  const proxy = loadProxyConfig(opts.configDir);

  const store = createThreadStore({
    maxMessagesPerThread: opts.maxMessagesPerThread ?? 200,
    maxThreads: opts.maxThreads ?? 100,
  });

  const channel = createChannel({
    self: agent.agentName,
    store,
    listPeers: () => listPeerHandles(opts.configDir, agent.agentName),
    send: ({ peer, contextId, text, participants }) =>
      sendOutbound({
        peer,
        contextId,
        text,
        self: agent.agentName,
        participants,
        deps: { localPort: proxy.localPort, host },
      }),
  });

  const emitInbound = (info: InboundInfo): void => {
    channel.notifyInbound(info).catch((err) => {
      process.stderr.write(
        `[claw-connect-adapter] notifyInbound failed: ${String(err)}\n`,
      );
    });
  };

  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    onInbound: emitInbound,
  });

  return {
    agent,
    close: async () => {
      await http.close();
      await channel.server.close();
    },
  };
}
```

- [ ] **Step 2: Typecheck the package.**

Run: `pnpm --filter a2a-claude-code-adapter typecheck`
Expected: 0 errors.

- [ ] **Step 3: Run all adapter unit tests except integration.**

Run: `pnpm --filter a2a-claude-code-adapter test -- --exclude test/integration.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit.**

```bash
git add packages/a2a-claude-code-adapter/src/start.ts
git commit -m "chore(adapter): wire start.ts to new channel send callback

The send callback now takes {peer, contextId, text, participants} and
returns {messageId}. Corresponds to the new sendOutbound signature."
```

---

## Task 6: Update existing integration test and add three-agent test

**Files:**
- Modify: `packages/a2a-claude-code-adapter/test/integration.test.ts`
- Create: `packages/a2a-claude-code-adapter/test/three-agent.test.ts`

- [ ] **Step 1: Update `test/integration.test.ts`.** Only the `send` tool calls change — the mock relay and fixture are fine. Find the two `aliceClient.callTool({ name: "send", arguments: {...} })` calls and the one `bobClient.callTool`:

Change every occurrence of `arguments: { peer: "X", text: "...", ... }` to `arguments: { peers: ["X"], text: "...", ... }`.

The response-shape check also changes — the old test reads `sendData.context_id` from the response; that still works (it's still there at the top level). Check the `expect(bobEvents[0]).toMatchObject({...})` for `peer: "alice", context_id: ctx` — keep that unchanged (peer is still a string in inbound meta).

If the test asserts the response is `{context_id, message_id}`, update to `{context_id, results: [{peer, message_id}]}`.

Concretely, rewrite the `it(...)` body in the "symmetric round-trip" block to:

```typescript
it("alice sends → bob receives event with peer=alice; bob continues thread; alice receives same context_id", async () => {
  aliceEvents = [];
  bobEvents = [];

  const sendResult = await aliceClient.callTool({
    name: "send",
    arguments: { peers: ["bob"], text: "hi bob" },
  });
  const sendData = JSON.parse((sendResult.content as any)[0].text);
  const ctx = sendData.context_id;
  expect(ctx).toBeTruthy();
  expect(sendData.results).toHaveLength(1);
  expect(sendData.results[0].peer).toBe("bob");
  expect(typeof sendData.results[0].message_id).toBe("string");

  await vi.waitFor(() => expect(bobEvents).toHaveLength(1));
  expect(bobEvents[0]).toMatchObject({
    method: "notifications/claude/channel",
    params: {
      content: "hi bob",
      meta: { peer: "alice", context_id: ctx },
    },
  });
  // Pairwise message — no participants attr.
  expect(bobEvents[0].params.meta.participants).toBeUndefined();

  const replyResult = await bobClient.callTool({
    name: "send",
    arguments: { peers: ["alice"], text: "hey alice", thread: ctx },
  });
  const replyData = JSON.parse((replyResult.content as any)[0].text);
  expect(replyData.context_id).toBe(ctx);

  await vi.waitFor(() => expect(aliceEvents).toHaveLength(1));
  expect(aliceEvents[0]).toMatchObject({
    method: "notifications/claude/channel",
    params: {
      content: "hey alice",
      meta: { peer: "bob", context_id: ctx },
    },
  });
});

it("send returns isError result when relay returns 404 (unknown tenant)", async () => {
  const result = await aliceClient.callTool({
    name: "send",
    arguments: { peers: ["nonexistent"], text: "hi" },
  });
  expect(result.isError).toBe(true);
  const data = JSON.parse((result.content as any)[0].text);
  expect(data.results).toHaveLength(1);
  expect(data.results[0].error.kind).toBe("peer-not-registered");
});
```

- [ ] **Step 2: Run integration test.**

Run: `pnpm --filter a2a-claude-code-adapter test integration`
Expected: PASS.

- [ ] **Step 3: Create `test/three-agent.test.ts`.** The structure mirrors `integration.test.ts`: mock relay with three registered tenants, three adapters, three MCP clients. Wolverine sends to [alice, bobby]. Assert both receive with `participants="wolverine alice bobby"`, shared contextId. Then alice reply-alls: `send(peers=[wolverine, bobby], thread=ctx, text=...)`. Assert wolverine and bobby both receive, still on the same contextId.

Write the file:

```typescript
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

function startMockRelay(adapters: Record<string, { httpPort: number }>) {
  const app = express();
  app.use(express.json());
  app.post("/:tenant/message\\:send", async (req, res) => {
    const sender = req.header("x-agent");
    if (!sender || !adapters[sender]) {
      res.status(403).json({ error: "X-Agent invalid" });
      return;
    }
    const tenant = req.params.tenant;
    const target = adapters[tenant];
    if (!target) {
      res.status(404).json({ error: "tenant not found" });
      return;
    }
    const body = {
      ...req.body,
      message: {
        ...req.body.message,
        metadata: { ...(req.body.message?.metadata ?? {}), from: sender },
      },
    };
    const upstream = await fetch(
      `http://127.0.0.1:${target.httpPort}/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await upstream.json();
    res.status(upstream.status).json(json);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      resolve({
        port,
        close: () => new Promise((r) => s.close(() => r())),
      });
    });
  });
}

function makeConfigDir(name: string, relayPort: number, httpPort: number) {
  const dir = mkdtempSync(path.join(tmpdir(), `adapter-${name}-`));
  writeFileSync(
    path.join(dir, "server.toml"),
    `
[server]
localPort = ${relayPort}

[agents.${name}]
localEndpoint = "http://127.0.0.1:${httpPort}"
`.trim(),
  );
  writeFileSync(path.join(dir, "remotes.toml"), "[remotes]\n");
  return dir;
}

describe("three-agent multi-peer fan-out", () => {
  let relay: { port: number; close: () => Promise<void> };
  let wolverine: { close: () => Promise<void> };
  let alice: { close: () => Promise<void> };
  let bobby: { close: () => Promise<void> };
  let wolverineClient: Client;
  let aliceClient: Client;
  let bobbyClient: Client;
  let wolverineEvents: any[] = [];
  let aliceEvents: any[] = [];
  let bobbyEvents: any[] = [];

  beforeAll(async () => {
    const allocPort = () =>
      new Promise<number>((resolve) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as any).port;
          s.close(() => resolve(p));
        });
      });
    const wolverinePort = await allocPort();
    const alicePort = await allocPort();
    const bobbyPort = await allocPort();
    relay = await startMockRelay({
      wolverine: { httpPort: wolverinePort },
      alice: { httpPort: alicePort },
      bobby: { httpPort: bobbyPort },
    });

    const wolverineDir = makeConfigDir("wolverine", relay.port, wolverinePort);
    const aliceDir = makeConfigDir("alice", relay.port, alicePort);
    const bobbyDir = makeConfigDir("bobby", relay.port, bobbyPort);

    const [wsT, wcT] = InMemoryTransport.createLinkedPair();
    const [asT, acT] = InMemoryTransport.createLinkedPair();
    const [bsT, bcT] = InMemoryTransport.createLinkedPair();

    wolverine = await start({
      configDir: wolverineDir,
      agentName: "wolverine",
      transport: wsT,
    });
    alice = await start({
      configDir: aliceDir,
      agentName: "alice",
      transport: asT,
    });
    bobby = await start({
      configDir: bobbyDir,
      agentName: "bobby",
      transport: bsT,
    });

    wolverineClient = new Client({ name: "test-wolverine", version: "0.0.1" }, {});
    aliceClient = new Client({ name: "test-alice", version: "0.0.1" }, {});
    bobbyClient = new Client({ name: "test-bobby", version: "0.0.1" }, {});
    wolverineClient.fallbackNotificationHandler = async (n) => {
      wolverineEvents.push(n);
    };
    aliceClient.fallbackNotificationHandler = async (n) => {
      aliceEvents.push(n);
    };
    bobbyClient.fallbackNotificationHandler = async (n) => {
      bobbyEvents.push(n);
    };
    await wolverineClient.connect(wcT);
    await aliceClient.connect(acT);
    await bobbyClient.connect(bcT);
  });

  afterAll(async () => {
    await wolverineClient.close();
    await aliceClient.close();
    await bobbyClient.close();
    await wolverine.close();
    await alice.close();
    await bobby.close();
    await relay.close();
  });

  it("wolverine sends to [alice, bobby] with one context_id; both receive with participants; alice reply-alls", async () => {
    wolverineEvents = [];
    aliceEvents = [];
    bobbyEvents = [];

    const sendResult = await wolverineClient.callTool({
      name: "send",
      arguments: { peers: ["alice", "bobby"], text: "three-way kickoff" },
    });
    const sendData = JSON.parse((sendResult.content as any)[0].text);
    expect(sendData.results).toHaveLength(2);
    const ctx = sendData.context_id;

    await vi.waitFor(() => {
      expect(aliceEvents).toHaveLength(1);
      expect(bobbyEvents).toHaveLength(1);
    });

    for (const ev of [aliceEvents[0], bobbyEvents[0]]) {
      expect(ev).toMatchObject({
        method: "notifications/claude/channel",
        params: {
          content: "three-way kickoff",
          meta: {
            peer: "wolverine",
            context_id: ctx,
            participants: "wolverine alice bobby",
          },
        },
      });
    }

    // Alice reply-alls to the other participants on the same thread.
    await aliceClient.callTool({
      name: "send",
      arguments: {
        peers: ["wolverine", "bobby"],
        text: "alice replies to all",
        thread: ctx,
      },
    });

    await vi.waitFor(() => {
      expect(wolverineEvents).toHaveLength(1);
      expect(bobbyEvents).toHaveLength(2);
    });

    expect(wolverineEvents[0]).toMatchObject({
      params: {
        content: "alice replies to all",
        meta: {
          peer: "alice",
          context_id: ctx,
          participants: "alice wolverine bobby",
        },
      },
    });
    expect(bobbyEvents[1]).toMatchObject({
      params: {
        content: "alice replies to all",
        meta: {
          peer: "alice",
          context_id: ctx,
          participants: "alice wolverine bobby",
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run the three-agent test.**

Run: `pnpm --filter a2a-claude-code-adapter test three-agent`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add packages/a2a-claude-code-adapter/test/integration.test.ts packages/a2a-claude-code-adapter/test/three-agent.test.ts
git commit -m "test(adapter): update integration for peers[] and add three-agent fan-out

Two-agent integration test migrated to peers:[<peer>]. New three-agent test
covers: shared contextId across fan-out, participants metadata delivery,
reply-all on the shared thread."
```

---

## Task 7: Update adapter README for multi-peer conversations

**Files:**
- Modify: `packages/a2a-claude-code-adapter/README.md`

- [ ] **Step 1: Rewrite the "send a message" section and add "Multi-peer conversations."**

Open `packages/a2a-claude-code-adapter/README.md` and:

1. In the first paragraph (currently describing the `send` tool contract), replace:
   > Claude replies by calling the `send` tool with `thread=<context_id>`

   with:
   > Claude replies by calling the `send` tool with `peers=[<peer>], thread=<context_id>`

   and replace:
   > `list_peers` to see who it can reach, `send` to open a thread — `send` returns an ack immediately (`{context_id, message_id}`)

   with:
   > `list_peers` to see who it can reach, `send` to open a thread — `send` returns an ack immediately (`{context_id, results: [{peer, message_id} | {peer, error}]}`)

2. In Step 3 of the walkthrough (the `POST to http://127.0.0.1:9901/bob/message:send` example), keep the HTTP shape as-is (the daemon wire is unchanged) but follow it with a new paragraph:

   > The MCP `send` tool wraps this as `{peers: ["bob"], text: "hello bob"}`. For multi-peer, pass multiple handles — see "Multi-peer conversations" below.

3. Add a new section after Step 3:

```markdown
## Multi-peer conversations

`send` accepts an array of peers. When you pass more than one, the adapter:

1. Mints **one** `context_id` shared by every recipient.
2. Adds a `participants` list (every recipient plus yourself) onto each outbound message's metadata.
3. Fans out pairwise deliveries over the existing daemon — no new wire shape, no room state, no membership.

On the receiving side, inbound events look like:

```
<channel source="claw-connect" peer="wolverine" participants="wolverine alice bobby"
         context_id="..." task_id="..." message_id="...">
three-way kickoff
</channel>
```

`peer` is the sender of this particular message; `participants` is everyone the sender considers part of the thread (including you and them). You choose how to respond:

- **Reply to the sender only:** `send({peers: ["wolverine"], thread: <context_id>, text: "..."})`
- **Reply-all:** `send({peers: <every participant except yourself>, thread: <context_id>, text: "..."})`
- **Branch off:** `send({peers: ["alice"], text: "..."})` (no `thread`) — starts a fresh pairwise thread.

There is no enforcement. There are no rooms. Agents negotiate these conventions the way humans do in group chat: sometimes you reply-all, sometimes you branch into a DM, sometimes your reply crosses someone else's in flight. This is intentional.

Partial failure is first-class: if one recipient is unreachable, `results` carries the error for that peer and the others are still delivered. The tool call returns `isError: true` only when **every** peer fails.

### Limits and caveats

- **No membership primitive.** The daemon has no idea a thread is "multi-party." It just sees N pairwise deliveries with the same `context_id`. Participants are a sender-stated convention, not a server-validated fact.
- **Trust the sender's list.** A receiver treats the `participants` list as informational — it's what the sender believes. If A sends to [B, C] and later sends to [B, D] on the same `context_id`, B sees the member set grow; D sees a participants list of `[A, B, D]` and doesn't know C was ever involved.
- **Pairwise clients still work.** If a recipient's adapter predates this feature, it will ignore `message.metadata.participants` and reply pairwise — the multi-party convention is strictly opt-in.
```

- [ ] **Step 2: Spot-check the updated README.**

Run: `wc -l packages/a2a-claude-code-adapter/README.md` and read the "Multi-peer conversations" section back in place. Make sure the fenced code blocks don't break the outer code fence (use triple-backtick consistently — the example inside the section needs its own language tag).

- [ ] **Step 3: Commit.**

```bash
git add packages/a2a-claude-code-adapter/README.md
git commit -m "docs(adapter): multi-peer conversations section

Documents the shared-contextId + participants-metadata convention. Covers
reply-all / reply-one / branch patterns, partial-failure semantics, and the
non-enforcement stance: conventions, not rooms."
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the adapter.**

Run: `pnpm --filter a2a-claude-code-adapter typecheck`
Expected: 0 errors.

- [ ] **Step 2: Typecheck the daemon (unchanged, but confirm nothing broke).**

Run: `pnpm --filter claw-connect typecheck`
Expected: 0 errors.

- [ ] **Step 3: Run the adapter test suite.**

Run: `pnpm --filter a2a-claude-code-adapter test`
Expected: all tests PASS (existing + new three-agent suite).

- [ ] **Step 4: Run the daemon test suite (regression check).**

Run: `pnpm --filter claw-connect test`
Expected: all ~270 tests PASS — the daemon is unchanged, but `injectMetadataFrom` is exercised by passthrough tests and should handle the new `participants` metadata key transparently. If any daemon test fails, stop and investigate — something about the `.loose()` metadata handling we assumed has drifted.

- [ ] **Step 5: Build both packages.**

Run: `pnpm -r build`
Expected: 0 errors.

- [ ] **Step 6: End-to-end smoke test from a fresh CLI invocation (optional but recommended).**

```bash
# In terminal 1:
cd /tmp && mkdir -p clawconnect-smoke-a && cd clawconnect-smoke-a
claw-connect claude-code:start --debug  # foreground
# (this takes over the terminal)

# In terminal 2 (new window):
cd /tmp && mkdir -p clawconnect-smoke-b && cd clawconnect-smoke-b
# print the ".mcp.json" + claude invocation from terminal 1's output and paste.

# In terminal 3:
cd /tmp && mkdir -p clawconnect-smoke-c && cd clawconnect-smoke-c
# same — another Claude session.

# In terminal 2 (first Claude session): ask Claude to `send` with peers=[<terminal-3-handle>] — confirm terminal 3 receives the <channel> block. Then ask Claude to send with peers=[<terminal-3-handle>, <one-more>] — confirm both receive, same context_id, same participants list.
```

Expected: both recipients get the event, participants attribute visible, reply-all works.

If you skip this, the three-agent vitest integration test is the canonical signal. Manual smoke is a sanity check that Claude Code's renderer handles the new `participants` meta key as expected — if it doesn't, file an issue and consider encoding it differently (e.g. as a data part rather than a top-level meta key).

- [ ] **Step 7: Final commit tag.**

```bash
git tag -a multi-peer-send -m "B+ shipped: multi-peer send, shared context, participants metadata"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `send` accepts `peers: string[]` — Task 4
- ✅ Shared context_id across fan-out — Task 4, step 1 (handleSend)
- ✅ `message.metadata.participants = [self, ...peers]` on outbound — Task 2 (sendOutbound) + Task 4 (handleSend)
- ✅ Daemon preserves metadata through `injectMetadataFrom` — Sanity check #1 (no code change needed)
- ✅ Inbound http parses participants from metadata — Task 3
- ✅ Inbound channel event surfaces `participants` attribute when multi-party — Task 4 (notifyInbound)
- ✅ thread-store multi-peer (`peers: Set<string>`, filter-by-membership) — Task 1
- ✅ Partial failure: per-peer results array — Task 4 (handleSend)
- ✅ Pairwise still works (length-1 `peers` array) — Task 4 tests, Task 6 integration
- ✅ Three-agent end-to-end fan-out + reply-all — Task 6 (three-agent.test.ts)
- ✅ Documentation — Task 7
- ✅ Full verification — Task 8

**Placeholder scan:** None detected. Every step has exact code or exact commands.

**Type consistency check:**
- `sendOutbound({peer, contextId, text, self, participants?, deps})` → `{messageId}` — consistent in Task 2 (definition), Task 4 (handleSend via CreateChannelOpts.send), Task 5 (start.ts wiring).
- `CreateChannelOpts.send({peer, contextId, text, participants?})` → `{messageId}` — matches sendOutbound signature (modulo `self` and `deps` injected by start.ts).
- `RecordArgs.peers: string[]` — Task 1 definition, used consistently in Task 4 (handleSend, notifyInbound), Task 6 tests.
- `ThreadSummary.peers: string[]` — Task 1 definition, used in Task 4 (handleListThreads) and tests.
- `InboundInfo.participants: string[]` — Task 3 definition, used in Task 4 (notifyInbound), Task 6 tests.
- `send` tool response `{context_id, results: [{peer, message_id} | {peer, error: {kind, message, hint}}]}` — Task 4 (handleSend), Task 6 (integration test assertions), Task 7 (README).

**Scope check:** Single feature (multi-peer send with participants convention), single package (`a2a-claude-code-adapter`). Daemon unchanged. Not decomposable further without losing testability of the round-trip.

**Ambiguity check:**
- "Multi-party" is defined as `peers.length > 1` at the send site, equivalently `info.participants.length > 1` at the receive site. Both code paths agree.
- `participants` on the wire is always a JSON array of strings; on the MCP notification it's a space-separated string. Deliberate — the wire shape is structured; the channel block attribute is flat.
- Dedup: handled at send site (`Array.from(new Set(peers))`). Not handled at receive site — if a sender sends a duplicated participants array, the recipient's thread-store will dedupe via Set semantics. Fine.

No issues found. Plan is ready.
