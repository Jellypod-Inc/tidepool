# Tidepool multi-party envelope improvements (P0–P2)

## Context

A three-agent audit (mongoose, fox, marmot) of Tidepool's multi-party threads surfaced four protocol improvements in `/Users/piersonmarks/Downloads/tidepool-protocol-improvements.md`. Two agents converged independently on addressee ambiguity as the #1 friction.

Today, a receiver can't answer any of these from the envelope: *who am I? am I being addressed? what message is this a reply to? did my message land?* Agents currently recover by parsing prose — brittle when peers don't cooperate.

This plan delivers P0–P2 (self + addressed_to, in_reply_to, explicit delivery acks). P3 (thread-canonical participants + reply_all) is deferred — it requires cross-daemon thread-state coordination, is audit-ranked lowest friction, and should get its own spec after P0–P2 lands.

Exploration notes: `docs/architecture.md`, `adapters/claude-code/src/channel.ts`, `adapters/claude-code/src/outbound.ts`, `src/server.ts`, `src/a2a.ts`, `src/peers/resolve.ts`.

## Design principles that shaped the decisions

- **Adapters stay thin.** Translate between a runtime's native API and the Tidepool daemon. Protocol logic (handle projection, fanout, envelope stamping, validation) lives in the daemon. Every new adapter (openclaw, others) gets the semantics for free.
- **Handles are scoped per-viewer.** `src/peers/resolve.ts:21` already projects bare vs scoped (`alice/fox`) per recipient. Wire-level identity must be canonical (DIDs/fingerprints) so each receiving daemon can re-project into its own view.
- **Prose stays the only agent-to-agent interface.** New envelope fields are *hints and metadata* for the adapter surface — agents coordinate in prose. `addressed_to` is explicitly non-enforcing; delivery ack is a transport signal, not a read receipt.
- **Optional A2A extension, soft degradation.** Peers that don't speak v1 ignore unknown metadata and keep working. Interop is preserved by construction.

## Scope

**In:**
- P0: `self` (always) + `addressed_to` (optional, hint) on inbound envelope and outbound send.
- P1: `in_reply_to` (optional) on outbound send and inbound envelope.
- P2: Explicit `delivery` outcome in `send` response.
- Infra prerequisites required for the above:
  - Move multi-peer fanout from adapter → daemon.
  - Unify `messageId` across a logical send (one ID for all recipients).
  - Move `participants` stamping from adapter → daemon, re-projected per recipient.
  - Lightweight `{context_id: Set<message_id>}` index on the daemon for `in_reply_to` validation.
  - Declare `tidepool/multi-party-envelope/v1` A2A extension on the agent card.

**Out (defer to separate specs):**
- P3 (thread-canonical participants, `participants_changed` events, `reply_all`).
- Read receipts (explicit anti-feature per audit).
- Floor control / typing indicators.
- Offline queueing.

**Pre-rollout prerequisite (non-code):**
- Survey openclaw and any other A2A-compatible implementations for extension compatibility before flipping on by default. We ship the code behind the declared extension URL; we don't change agent-card `required` behavior until the survey confirms no peer breakage.

## Protocol changes

### Wire envelope (daemon ↔ daemon, A2A `Message.metadata`)

Add to `message.metadata` for messages tagged with extension `tidepool/multi-party-envelope/v1`:

```
metadata: {
  // existing
  from: <receiver-scoped local handle>,   // daemon-injected, unchanged
  participants: [<peer DIDs>],            // MOVED: now DIDs, stamped by sender's daemon (was adapter-stamped string[])

  // new
  addressed_to: [<peer DIDs>]?,            // optional, subset of fanout recipients
  in_reply_to: <message_id>?,              // optional, must reference a message_id in the same context
}
```

Identity on the wire is always DID/fingerprint. Each receiver's daemon re-projects `participants` and `addressed_to` into the receiver's handle view before exposing to the adapter.

### MCP channel (daemon → adapter → agent)

Inbound `<channel>` notification gains:

```
<channel source="tidepool"
         peer="<sender-in-receiver-view>"
         self="<receiver-own-handle-in-receiver-view>"
         context_id="..." task_id="..." message_id="..."
         participants="marmot fox mongoose"
         addressed_to="fox"                  <!-- omitted on broadcast -->
         in_reply_to="<message_id>">         <!-- omitted when not a reply -->
...body...
</channel>
```

`self` is always present. `addressed_to` / `in_reply_to` appear only when set. `participants` remains space-separated for multi-party, absent on pairwise (unchanged surface rule).

### MCP `send` tool input

```
{
  peers: string[],
  text: string,
  thread?: string,
  addressed_to?: string[],    // NEW — subset of peers (receiver-view handles allowed; daemon validates)
  in_reply_to?: string        // NEW — must be a message_id visible in `thread`
}
```

### MCP `send` tool response

```
{
  context_id: string,
  message_id: string,          // NEW — single shared logical messageId for this send
  results: [
    { peer: string, delivery: "accepted", },                    // renamed from message_id-present
    { peer: string, delivery: "failed",  reason: { kind, message, hint? } }
  ]
}
```

Per-peer `message_id` is dropped from `results` — the shared top-level `message_id` replaces it. `delivery` makes the wire outcome explicit.

### Daemon endpoint shape

New single-call fanout endpoint; adapter stops looping over peers:

```
POST /message:broadcast
Headers: X-Session-Id: <adapter-session>
Body: {
  peers: string[],            // receiver-view handles from the adapter
  text: string,
  thread?: string,
  addressed_to?: string[],
  in_reply_to?: string
}
```

Daemon responsibilities (per-call):
1. Resolve sender agent from `X-Session-Id`.
2. Resolve each `peers[i]` to a peer DID via `peers.toml` + agent mapping.
3. Validate `addressed_to ⊆ peers` → reject `invalid_addressed_to` if not.
4. If `in_reply_to` set, check against the thread-index → reject `invalid_in_reply_to` if not found (fail-open for IDs older than the index window).
5. Mint one `message_id`; mint `context_id` if not provided.
6. Translate `participants` and `addressed_to` into DIDs.
7. Fan out per-peer with the shared `message_id`; each leg carries the v1 extension metadata.
8. Collect per-peer wire outcomes; return the aggregated response.

The legacy `POST /<peer>/message:send` proxy path (`src/server.ts:772`) stays for now (adapter-compat during migration) but becomes a single-peer special case of broadcast, or we remove it in the same PR — decide at implementation time.

### Inbound stamping (receiver daemon)

On inbound, before forwarding to the adapter SSE session:
1. Look up local agent target from the URL path (existing path).
2. Resolve `self` = that agent's handle in the *receiver's* projection, inject into metadata.
3. Re-project `participants` DIDs → receiver-view handle strings.
4. Re-project `addressed_to` DIDs → receiver-view handle strings.
5. Record `message_id` into the lightweight thread-index at `(context_id, message_id)` for future `in_reply_to` validation.
6. Stream to the adapter, which renders the `<channel>` tag verbatim from metadata.

### A2A extension declaration

Add to `src/agent-card.ts:37` alongside the existing connection extension:

```
declareExtension(MULTI_PARTY_ENVELOPE_V1_URL, {
  description: "Tidepool multi-party envelope: self, addressed_to, in_reply_to, shared message_id, delivery acks",
  required: false,
}),
```

`required: false` is the interop contract — old peers keep working, they just don't populate the new fields.

## Lightweight thread-index

New module (e.g., `src/thread-index.ts`):

- In-memory `Map<context_id, { ids: Set<message_id>, last_seen: number }>`.
- Updated on every inbound AND outbound message.
- LRU-evicted by `last_seen` with a cap (e.g., 1k threads, 1k ids/thread — tuneable).
- `has(context_id, message_id) → boolean | "unknown"`; `unknown` means beyond the window.
- `in_reply_to` validation rule: `has === false` → reject; `has === true` or `unknown` → accept.
- Not persisted across daemon restart; rebuilds from new traffic. Acceptable because its only job is rejecting obviously-bogus IDs, not reconstructing history.

## Files to modify

**Daemon:**
- `src/a2a.ts` — extend `MessageMetadataSchema` / `Message` with optional `addressed_to`, `in_reply_to`; move `participants` to DID array type.
- `src/schemas.ts`, `src/wire-validation.ts` — Zod schemas for new metadata fields.
- `src/server.ts` — add `POST /message:broadcast`; update inbound handler (`~line 264–486`) to re-project and stamp `self` / `participants` / `addressed_to`; wire thread-index record on inbound and outbound.
- `src/peers/resolve.ts` — add helpers: `handleToDid(peers, handle)`, `didToHandle(peers, did, viewer)`, plus batch versions.
- `src/agent-card.ts` — declare v1 extension.
- `src/thread-index.ts` — new.
- `src/middleware.ts` — honor the v1 extension declaration (parse `x-a2a-extensions` consistent with existing pattern at `middleware.ts:61`).

**Adapter (`adapters/claude-code/`):**
- `src/channel.ts:82–150` — update `send` input schema (add `addressed_to`, `in_reply_to`); update `send` output to `{context_id, message_id, results: [{peer, delivery, reason?}]}`; remove adapter-side `[self, ...peers]` participants stamping at `channel.ts:170`.
- `src/outbound.ts` — replace per-peer `message:send` fanout loop with a single `POST /message:broadcast` call and response unpacking.
- `src/channel.ts:376–388` — render `self`, `addressed_to`, `in_reply_to` attributes on the channel tag when present; `self` always; others conditional.
- `src/thread-store.ts` — store under shared `message_id` per send (not per-leg); update `list_threads` / `thread_history` projections accordingly.

**Tests:**
- `test/` — mirror each module changed.
- New `e2e-multi-party-envelope.test.ts` covering the 7 cases in the feedback doc's "Test cases to cover":
  1. Receiving agent sees correct `self` in a 3+ peer thread.
  2. `addressed_to=["fox"]` in a 3-peer thread: both fox and marmot receive; `addressed_to` is identical in their envelopes (re-projected correctly into each's view).
  3. `addressed_to` containing a handle not in `peers` → `invalid_addressed_to` at send.
  4. `in_reply_to` referencing a message from a different thread → `invalid_in_reply_to`.
  5. Two peers both send `in_reply_to=<same_id>` in parallel → both succeed; neither is `in_reply_to` the other.
  6. Shared `message_id`: fox and marmot see the same `message_id` for a fanout from mongoose.
  7. Delivery ack: `delivery: "failed"` surfaces for an offline peer; `delivery: "accepted"` for an online one who never replies.

**Docs (same change, per CLAUDE.md rules):**
- `docs/architecture.md` — update §6 (protocol surface) for new endpoint + envelope fields; update §4 (middleware pipeline) for new validation stages; note the v1 extension in the extensions inventory.
- `tasks/` — mark P3 as a follow-up item referencing this spec.

## Rollout order

1. **Infra PR:** daemon fanout endpoint + shared messageId + participants DID-stamping + re-projection helpers. No new agent-facing fields yet; adapter still sends today's shape (adapter wraps into broadcast call behind the scenes). Ship-tested via existing smoke/e2e.
2. **P0 PR:** `self` + `addressed_to` end-to-end, validation, extension declaration on the agent card. Adapter surfaces the attributes.
3. **P1 PR:** `in_reply_to` + thread-index + validation. Adapter surfaces the attribute.
4. **P2 PR:** `delivery` field in `send` response; collapse per-peer `message_id` to shared top-level `message_id`.
5. **Survey openclaw + other A2A peers** before any public announcement; confirm soft-degradation holds.

Each PR is independently shippable; each is backwards compatible by construction (unknown metadata is ignored at receive).

## Verification

- `pnpm build && pnpm typecheck` clean across workspace.
- `pnpm test:all` green, including new e2e cases.
- `pnpm smoke` (scripts/smoke.ts) with a 3-peer fixture added: confirm `self`, `addressed_to`, shared `message_id`, `delivery` end-to-end.
- Manual mixed-peer test: one peer running the post-change daemon, one running pre-change (from git). Confirm:
  - Pre-change peer sends → post-change peer: post-change peer degrades gracefully (no `self` / `addressed_to` consumed, today's prose path still works).
  - Post-change peer sends → pre-change peer: extension fields are ignored by old peer; old peer's inbound still renders as today.
- Replay the original 3-agent audit scenario (mongoose, fox, marmot) and confirm the seven test cases pass.
