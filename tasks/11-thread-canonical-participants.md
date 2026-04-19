# Task 11: Thread-canonical participants + reply_all (P3)

**Status:** Deferred from [multi-party envelope v1 design](../docs/superpowers/specs/2026-04-17-multi-party-envelope-design.md).

## Why deferred

The external 3-agent audit ranked this **lowest friction** of the four envelope improvements. It also requires the first real cross-daemon coordination primitive — daemons would need to agree on a thread's participant list and propagate changes. That's a meaningful architectural step that deserves its own design pass rather than riding on the envelope-additive v1 spec.

## Problem statement

Today the participants list is **stamped per-message** by the sender. A peer can silently drop another participant by replying to a subset of `peers`, and the dropped peer has no way to notice they've been excluded from subsequent turns. Membership is a convention, not a fact.

## Scope

### (a) Thread-canonical participants

Promote per-thread participant state to a daemon-level record. Each thread has an authoritative membership list. Changes become first-class events.

- Daemon stores `{ contextId: { participants: Set<AgentDid>, lastUpdated: number } }` (persisted or LRU-evicted — open question).
- When a recipient joins or drops, emit a `<channel kind="participants_changed" thread="<cid>" added="..." removed="..." by="..."/>` event to all current members.
- Open: authoritative-per-thread (one daemon "owns" the thread) vs gossip. Tradeoffs: authoritativity simplifies semantics but requires ownership election on multi-daemon threads. Gossip is eventually-consistent but avoids ownership.

### (b) `reply_all` shortcut on `message:broadcast`

Once (a) exists, this is trivial:

```json
{ "thread": "<cid>", "reply_all": true, "text": "..." }
```

Resolves to the current thread's participants minus `self`. Removes a class of "oops I forgot to include marmot" bugs.

### Non-goals (as noted in v1 spec)

- Floor control / typing indicators
- Read receipts
- Offline queueing

## Dependencies

- Multi-party envelope v1 shipped (the `feat/multi-party-envelope` branch).
- `ThreadIndex` already exists as a lightweight LRU message-id index; P3's canonical participant list is a new data structure alongside (or replacing) it.

## Open design questions

1. **Persistence.** Ephemeral (lost on daemon restart) or disk-backed?
2. **Ownership model.** Authoritative daemon vs gossip vs CRDT merge?
3. **Participant-change authorization.** Can any member add? Only the original creator? Do removals require quorum?
4. **Backwards compatibility.** Old peers that don't speak P3 can't emit `participants_changed` — do they get silently excluded from membership changes, or treated as authoritative for their own participants list?

Answer these in a design spec before implementation.
