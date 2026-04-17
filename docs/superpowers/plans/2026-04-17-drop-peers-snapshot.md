# Drop `peers.snapshot` — SSE session becomes liveness-only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `peers.snapshot` event from the SSE session. Adapters fetch `GET /.well-known/tidepool/peers` on demand instead of maintaining a pushed cache.

**Architecture:** The SSE session's purpose becomes "liveness signal + session exclusivity" only. Registration happens via the POST body that opens the stream. After that, keepalive pings flow; no other events. Adapters that need the peer list call `/peers` when they need it.

**Tech Stack:** TypeScript, Express, Vitest, SSE, undici `fetch`.

---

## Context

The original design emitted a `peers.snapshot` event at session-open time and re-emitted on every friends-change (fanout). After review:

- `list_peers` is a rare MCP tool call — localhost `fetch` cost is negligible.
- Cache invalidation via push is a bug-rich pattern compared to fetch-on-demand.
- Staleness fails cleanly with `peer_not_found`; no silent misroute.
- The SSE session's single valuable property — liveness — doesn't need events.

So: drop the event on both ends, make `listPeers` async-fetch-based, cancel the fanout work.

## Files touched

**Daemon (`src/`):**
- `src/session/endpoint.ts` — remove `peers.snapshot` emission and `broadcastFriends`; drop `friendsSnapshot` option; `MountedSession.notifyFriendsChanged` goes away
- `src/server.ts` — stop wiring the friends-changed listener into the session broadcaster
- `src/config-holder.ts` — the `onFriendsChanged` API can remain (harmless, may be used later) or be removed for YAGNI — defer to review

**Adapter (`adapters/claude-code/src/`):**
- `adapters/claude-code/src/session-client.ts` — delete `peers.snapshot` handling and the `onPeers` option
- `adapters/claude-code/src/start.ts` — delete `peersBox`; wire `listPeers` to a fetch-on-demand function
- `adapters/claude-code/src/channel.ts` — change `listPeers: () => string[]` to `listPeers: () => Promise<string[]>`; update `handleListPeers` to await
- New helper: `adapters/claude-code/src/peers-client.ts` — small function that fetches `GET /.well-known/tidepool/peers` and parses

**Tests:**
- `test/session-endpoint.test.ts` — drop assertions about `peers.snapshot`
- `test/session-fanout.test.ts` — delete (if exists; task 8 was in-progress)
- `adapters/claude-code/test/session-client.test.ts` — drop `peers.snapshot` assertions
- `adapters/claude-code/test/integration.test.ts` and `three-agent.test.ts` — if they rely on snapshot events, switch to `GET /peers`

**Spec:**
- `docs/superpowers/specs/2026-04-17-adapter-interface-design.md` — update "Minimum event set" and flow diagrams

---

## Task 1: Remove `peers.snapshot` from daemon session endpoint

**Files:**
- Modify: `src/session/endpoint.ts`
- Modify: `test/session-endpoint.test.ts`

- [ ] **Step 1: Update test — session no longer emits peers.snapshot**

Open `test/session-endpoint.test.ts`, find the test asserting `peers.snapshot` is emitted. Replace with an assertion that the stream contains `session.registered` but NOT `peers.snapshot`:

```ts
it("emits session.registered but not peers.snapshot", async () => {
  // ... existing setup: open session ...
  const chunk = await readFirstEvents(stream);
  expect(chunk).toContain("event: session.registered");
  expect(chunk).not.toContain("event: peers.snapshot");
});
```

- [ ] **Step 2: Run test — verify it fails**

```
pnpm vitest run test/session-endpoint.test.ts
```

Expected: FAIL — current code still emits `peers.snapshot`.

- [ ] **Step 3: Remove the emission and the broadcaster**

In `src/session/endpoint.ts`:
- Delete line `writeEvent(res, "peers.snapshot", opts.friendsSnapshot());` at :103
- Delete the `broadcastFriends` function and the `subscribers` Set
- Delete `res.on("close", cleanup)` block's `subscribers.delete(res)` line
- Remove `friendsSnapshot` from `MountSessionOpts`
- Remove `notifyFriendsChanged` from `MountedSession` (the function returns `void` now, or an empty object — minimize diff by returning `{}`)

Updated file shape:

```ts
export interface MountSessionOpts {
  registry: SessionRegistry;
  port: number;
}

export interface MountedSession {}

export function mountSessionEndpoint(
  app: Express,
  opts: MountSessionOpts,
): MountedSession {
  app.post("/.well-known/tidepool/agents/:name/session", (req, res) => {
    // ... Origin/Host check, body validation, registry.register (unchanged) ...

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders?.();

    writeEvent(res, "session.registered", { sessionId: result.session.sessionId });

    const keepalive = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepalive);
      opts.registry.deregister(result.session.sessionId);
    });
  });

  return {};
}
```

- [ ] **Step 4: Run session-endpoint tests — verify pass**

```
pnpm vitest run test/session-endpoint.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/session/endpoint.ts test/session-endpoint.test.ts
git commit -m "refactor(session): drop peers.snapshot from SSE session"
```

---

## Task 2: Unwire friends-change → session broadcast in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Find the wiring**

Search `src/server.ts` for `notifyFriendsChanged`, `onFriendsChanged`, or calls that pass `friendsSnapshot` to `mountSessionEndpoint`.

- [ ] **Step 2: Remove the wiring and the `friendsSnapshot` arg**

Before:
```ts
const session = mountSessionEndpoint(app, {
  registry,
  port: config.server.localPort,
  friendsSnapshot: () => buildPeersSnapshot(holder.friends()),
});
holder.onFriendsChanged(() => session.notifyFriendsChanged());
```

After:
```ts
mountSessionEndpoint(app, {
  registry,
  port: config.server.localPort,
});
```

If `buildPeersSnapshot` is now unused, leave it — it's still needed by the `GET /peers` route (Task 9's endpoint handler).

- [ ] **Step 3: Run full test suite**

```
pnpm vitest run
```

Expected: green. If `config-holder.test.ts` relied on the `onFriendsChanged` consumer existing, update it; the API may remain but is unused.

- [ ] **Step 4: Commit**

```
git add src/server.ts
git commit -m "refactor(server): unwire session broadcaster from friends-change"
```

---

## Task 3: Drop the fanout task's in-progress code (if present)

**Files:**
- Delete (if exists): `test/session-fanout.test.ts`
- Delete (if exists): `src/session/fanout.ts`, or any partial `broadcastPeers` method in `src/session/registry.ts`

- [ ] **Step 1: Survey for partial work**

```
find src/session test -name '*.ts' | xargs grep -l 'broadcastPeers\|notifyFriendsChanged\|fanout'
```

- [ ] **Step 2: Delete partial files and remove `broadcastPeers` from `SessionRegistry` interface if added**

If `src/session/registry.ts` has a `broadcastPeers` method, remove it (interface + implementation).

- [ ] **Step 3: Run tests**

```
pnpm vitest run
```

Expected: green.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "chore(session): remove in-progress peers fanout"
```

---

## Task 4: Add peer-fetch helper in the adapter

**Files:**
- Create: `adapters/claude-code/src/peers-client.ts`
- Create: `adapters/claude-code/test/peers-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// adapters/claude-code/test/peers-client.test.ts
import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPeers } from "../src/peers-client.js";

describe("fetchPeers", () => {
  it("fetches GET /.well-known/tidepool/peers and returns the parsed array", async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe("/.well-known/tidepool/peers");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { handle: "alice", did: null },
        { handle: "bob",   did: null },
      ]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      const peers = await fetchPeers(`http://127.0.0.1:${port}`);
      expect(peers).toEqual([
        { handle: "alice", did: null },
        { handle: "bob",   did: null },
      ]);
    } finally {
      server.close();
    }
  });

  it("throws a helpful error on non-2xx", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500).end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(fetchPeers(`http://127.0.0.1:${port}`)).rejects.toThrow(
        /HTTP 500/,
      );
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```
pnpm --filter a2a-claude-code-adapter vitest run test/peers-client.test.ts
```

Expected: FAIL — `peers-client` module does not exist.

- [ ] **Step 3: Implement the helper**

```ts
// adapters/claude-code/src/peers-client.ts
export type Peer = { handle: string; did: string | null };

export async function fetchPeers(daemonUrl: string): Promise<Peer[]> {
  const url = `${daemonUrl}/.well-known/tidepool/peers`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `fetchPeers: HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error("fetchPeers: expected JSON array from /peers");
  }
  return json as Peer[];
}
```

- [ ] **Step 4: Run tests — verify pass**

```
pnpm --filter a2a-claude-code-adapter vitest run test/peers-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add adapters/claude-code/src/peers-client.ts adapters/claude-code/test/peers-client.test.ts
git commit -m "feat(adapter): add fetchPeers helper for on-demand peer lookup"
```

---

## Task 5: Remove `peers.snapshot` handling from session client

**Files:**
- Modify: `adapters/claude-code/src/session-client.ts`
- Modify: `adapters/claude-code/test/session-client.test.ts`

- [ ] **Step 1: Update tests — session client no longer needs `onPeers`**

Edit `session-client.test.ts`: remove all `onPeers` callback assertions. The test should verify:
- session registration request body shape
- `session.registered` event resolves `openSession`
- `peers.snapshot` events (if the daemon were to send them) are ignored without error

```ts
// Replace the "emits peer snapshots to onPeers" test with:
it("ignores unknown event types without throwing", async () => {
  const server = startFakeDaemon((res) => {
    writeEvent(res, "session.registered", { sessionId: "s1" });
    writeEvent(res, "something.unexpected", { nope: true });
  });
  const handle = await openSession({
    daemonUrl: server.url,
    name: "alice",
    endpoint: "http://127.0.0.1:1111",
    card: {},
  });
  expect(handle.sessionId).toBe("s1");
  await handle.close();
});
```

- [ ] **Step 2: Run test — verify it fails**

```
pnpm --filter a2a-claude-code-adapter vitest run test/session-client.test.ts
```

Expected: FAIL — `onPeers` is required in `OpenSessionOpts`.

- [ ] **Step 3: Remove `onPeers` from the client**

In `session-client.ts`:
- Delete `onPeers: (peers: Peer[]) => void` from `OpenSessionOpts`
- Delete the `else if (ev === "peers.snapshot")` branch in the SSE reader loop
- Remove the `Peer` export (move it to `peers-client.ts` if not already there — it is per Task 4)

Result: `OpenSessionOpts` becomes:

```ts
export interface OpenSessionOpts {
  daemonUrl: string;
  name: string;
  endpoint: string;
  card: Record<string, unknown>;
  onError?: (err: Error) => void;
}
```

- [ ] **Step 4: Run tests — verify pass**

```
pnpm --filter a2a-claude-code-adapter vitest run test/session-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add adapters/claude-code/src/session-client.ts adapters/claude-code/test/session-client.test.ts
git commit -m "refactor(adapter): drop peers.snapshot handling from session client"
```

---

## Task 6: Wire `listPeers` in the adapter to fetch on demand

**Files:**
- Modify: `adapters/claude-code/src/start.ts`
- Modify: `adapters/claude-code/src/channel.ts`
- Modify: `adapters/claude-code/test/channel.test.ts`

- [ ] **Step 1: Update channel test — `listPeers` is async**

Find any `listPeers: () => [...]` in `channel.test.ts` and change to `listPeers: async () => [...]`. The `list_peers` tool handler already awaits.

- [ ] **Step 2: Make `listPeers` async in channel.ts**

Change the type:

```ts
// adapters/claude-code/src/channel.ts:16
listPeers: () => Promise<string[]>;
```

Change `handleListPeers` to await:

```ts
const handleListPeers = async (): Promise<ToolCallResult> => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        peers: (await opts.listPeers())
          .slice()
          .sort()
          .map((handle) => ({ handle })),
      }),
    },
  ],
});
```

Update the switch dispatch to `await handleListPeers()`:

```ts
case "list_peers":
  return handleListPeers();  // already returns a Promise; await happens in caller
```

- [ ] **Step 3: Update start.ts — remove peersBox, use fetchPeers**

Remove the `peersBox` mechanism:

```ts
// adapters/claude-code/src/start.ts
import { fetchPeers } from "./peers-client.js";

// Delete peersBox and its assignment.

const channel = createChannel({
  self: agent.agentName,
  store,
  listPeers: async () => {
    const peers = await fetchPeers(`http://${host}:${proxy.localPort}`);
    return peers.map((p) => p.handle);
  },
  send: /* unchanged */,
});
```

Remove the `onPeers` arg passed to `openSession` — no longer in its signature.

- [ ] **Step 4: Run adapter tests**

```
pnpm --filter a2a-claude-code-adapter vitest run
```

Expected: mostly PASS. Integration tests that were asserting snapshot-driven behavior need a quick review — see Task 7.

- [ ] **Step 5: Commit**

```
git add adapters/claude-code/src/start.ts adapters/claude-code/src/channel.ts adapters/claude-code/test/channel.test.ts
git commit -m "refactor(adapter): fetch peers on demand instead of cached snapshot"
```

---

## Task 7: Fix integration tests that relied on snapshot-based updates

**Files:**
- Modify: `adapters/claude-code/test/integration.test.ts`
- Modify: `adapters/claude-code/test/three-agent.test.ts`

- [ ] **Step 1: Survey what's broken**

```
pnpm --filter a2a-claude-code-adapter vitest run
```

Note any failures related to:
- "expected onPeers to have been called"
- "peer list did not update after adding friend"

- [ ] **Step 2: Replace push-based assertions with fetch-based**

For any test that asserts "after adding carol as a friend, the adapter's `list_peers` includes carol": instead of waiting for a snapshot callback, invoke the MCP `list_peers` tool (which now fetches fresh) and assert the result.

Example pattern:

```ts
// Before:
await waitForPeersSnapshot(sessionClient, (p) => p.some((x) => x.handle === "carol"));

// After:
await addFriend(daemon, "carol", fingerprint);
const result = await channel.handleToolCall({ name: "list_peers", arguments: {} });
const peers = JSON.parse(result.content[0].text).peers.map((p: any) => p.handle);
expect(peers).toContain("carol");
```

- [ ] **Step 3: Run all tests — verify pass**

```
pnpm vitest run
pnpm --filter a2a-claude-code-adapter vitest run
```

Expected: all green.

- [ ] **Step 4: Commit**

```
git add adapters/claude-code/test/integration.test.ts adapters/claude-code/test/three-agent.test.ts
git commit -m "test(adapter): update integration tests for fetch-based peer lookup"
```

---

## Task 8: Update the design spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-17-adapter-interface-design.md`

- [ ] **Step 1: Update the "Minimum event set (v1)" section**

Replace the table with:

```markdown
| Event | Purpose | Payload |
|-------|---------|---------|
| `session.registered` | Initial ack after successful registration | `{ sessionId }` |

After `session.registered`, the stream carries only SSE keepalive pings
(`: ping\n\n` every 15s). Peer-list updates are NOT pushed — adapters fetch
`GET /.well-known/tidepool/peers` on demand. Rationale:

- `list_peers` is called rarely (per LLM turn at most); localhost fetch cost
  is negligible.
- Cache invalidation via push is bug-prone vs. fetch-on-demand.
- Staleness fails cleanly via `peer_not_found` on send; no silent misroute.
```

- [ ] **Step 2: Update any flow diagrams or acceptance criteria that mention `peers.snapshot`**

Search the spec for `peers.snapshot` and `peers.snapshot` mentions, remove or update.

- [ ] **Step 3: Commit**

```
git add docs/superpowers/specs/2026-04-17-adapter-interface-design.md
git commit -m "docs(spec): drop peers.snapshot; SSE session is liveness-only"
```

---

## Self-review checklist

- [ ] No `peers.snapshot` string remains in `src/session/`
- [ ] No `peers.snapshot` string remains in `adapters/claude-code/src/`
- [ ] `fetchPeers` is the single path adapters use to learn peers
- [ ] `listPeers` in `channel.ts` is `async`
- [ ] All tests pass (`pnpm vitest run` + `pnpm --filter a2a-claude-code-adapter vitest run`)
- [ ] Spec updated; no stale references to snapshot-based updates
- [ ] The SSE session's only non-keepalive event is `session.registered`

## Effort estimate

~2-3 hours total. Each task is small (minutes to tens of minutes). The work is mostly deletion + one helper addition + one type change from sync to async.
