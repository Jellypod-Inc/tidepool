# Symmetric threads + multi-peer identity (design)

**Date:** 2026-04-15
**Status:** Approved (pending implementation plan)

## Background

A Claude agent road-tested the current claw-connect + a2a-claude-code-adapter system and surfaced two must-fix issues plus several nice-to-haves:

1. **Asymmetric reply** — only the non-initiator can reply on a given task_id; continuing a conversation requires choreographing who opens what.
2. **Inbound events lack peer identity** — channel events don't say who sent them; multi-peer routing is impossible.
3. (Nice-to-have) `list_threads`, `thread_history`, group messaging, `peer_status`.

This spec redesigns the system to fix (1) and (2) cleanly, ships (nice-to-have) thread listing/history, and explicitly defers group messaging and presence to separate future specs.

## Non-goals

- **Group messaging / multicast** — not in A2A spec; deferred to its own spec when concrete need surfaces.
- **Peer presence / `peer_status`** — would require a custom A2A extension; deferred.
- **Cross-session persistence of thread history** — adapter is per-session; thread history dies with the Claude Code session by design.
- **Backwards compatibility with the current `claw_connect_reply` / sync-await flow** — we're cleanly breaking it.

## Guiding principles

1. **Wire is pure A2A.** No custom extensions. We use only `messageId`, `contextId`, `metadata`, `parts`, and standard `message:send`. If A2A evolves, peers negotiate via Agent Card; we ride along.
2. **claw-connect server stays agent-agnostic.** It is a NAT-style relay + identity injector. It knows nothing about Claude Code, channels, threads, or any agent UX. Adapters connect agent-specific functionality.
3. **Adapters are per-agent.** Each agent runtime (Claude Code today; possibly Codex, a CLI bot, or third-party A2A clients tomorrow) has its own adapter. Adapters need not implement the same features. Nothing on the wire requires any specific adapter feature.
4. **Full interoperability.** A peer that doesn't implement `list_threads` or `thread_history` is still a fully-participating peer. It just loses those local UX features.
5. **Ephemeral state.** No disk persistence. The adapter is per-session; the server is per-process; the wire is stateless. Lifetimes match the user's mental model.
6. **Symmetric peer-to-peer messaging.** Each `message:send` is its own atomic exchange. Threads (`contextId`) carry continuity, not tasks. Either side can initiate a message; neither is special.

## Architecture (three layers)

### Layer 1 — A2A wire

Pure protocol. Each `message:send` carries:

| Field | Semantics |
|---|---|
| `message.messageId` | Sender-minted UUID. Dedup + logs. |
| `message.contextId` | First message in a thread mints; all subsequent messages in the thread reuse. The thread identifier. |
| `message.metadata.from` | **Set by the receiving claw-connect.** The recipient's local handle for the sender. Sender-supplied values are ignored/overwritten. |
| `message.parts` | Content (text only initially; A2A's `parts` model leaves room for richer types later). |

Each `message:send` returns a `Task` in state `completed` with no reply message — pure ack. Replies travel as fresh `message:send` calls in the other direction, reusing `contextId`. No task continuation; no streaming.

A2A's `tasks:list`, `tasks:get`, etc. are **not required** by this design. Adapters maintain their own local state.

### Layer 2 — claw-connect server (NAT-style relay)

Stateless. Routes `message:send` between local agents and remote peers. Its only new responsibility is **identity injection**:

| Boundary | Identity carried | How |
|---|---|---|
| Adapter ↔ local server (localhost) | local agent name | `X-Agent: alice` header (localhost trust; no secrets needed) |
| Server ↔ remote server (mTLS) | host = mTLS cert; agent on host = `X-Sender-Agent` header | sending server sets `X-Sender-Agent`; receiving server reads it after mTLS auth |
| Server → adapter (forward to local) | recipient's local handle for sender | server injects `metadata.from = "<local-handle>"` into the A2A body |

**Translation table:** `remotes.toml` (already exists) maps remote-peer-and-agent → local-handle. Static, set at peering time. NAT-style mapping; agents only see their local handle namespace.

**Server responsibilities (final):**
1. Validate `X-Agent` against `server.toml` for local-originated requests; reject with 403 if missing or unknown.
2. Look up recipient (URL path) → local agent endpoint, or `remotes.toml` → remote peer endpoint.
3. For local→local: inject `metadata.from = <X-Agent value>`, forward.
4. For local→remote: set `X-Sender-Agent: <X-Agent value>`, mTLS-send to remote peer.
5. For remote→local: identify peer via mTLS, read `X-Sender-Agent`, look up local handle for `<sender-agent>@<peer>`, inject `metadata.from = <local-handle>`, forward.
6. Pass through everything else (contextId, messageId, parts) untouched.

**Server explicitly does NOT do:**
- Maintain thread state.
- Implement `tasks:list` or `tasks:get`.
- Have any concept of channels, replies, presence, or groups.
- Translate `contextId` (it's end-to-end identical, like an IP payload).

### Layer 3 — a2a-claude-code-adapter

Maps A2A ↔ Claude Code channels. Per-session, in-memory, ephemeral.

**Outbound (`send` tool):** mints `messageId` + `contextId` (or reuses caller-supplied `thread`), builds A2A body with no `from` field, POSTs to local server with `X-Agent: <self>`, awaits ack, returns `{context_id, message_id}` to Claude. Records the outbound message in the local thread store. Returns immediately — no waiting for reply.

**Inbound (`/message:send` HTTP endpoint):** validates the A2A body, reads `metadata.from`, mints a per-message `task_id`, records the message in the local thread store, emits a channel event with `peer`/`context_id`/`task_id`/`message_id`, returns A2A `Task{state: completed}`. No correlation with any prior outbound; no pending registry.

**Local thread store (in-memory):**
- `Map<context_id, ThreadRecord>` where `ThreadRecord = {peer, last_activity, messages: RingBuffer<Message>}`.
- Defaults: 200 messages per thread, 100 threads max, evict by `last_activity`. Configurable via env/CLI.
- Lost on adapter restart — same lifetime as the Claude Code session.

## Channel event shape

Every inbound channel event has this exact shape:

```
<channel source="claw-connect" peer="bob" context_id="C-uuid" task_id="T-uuid" message_id="M-uuid">
text content here
</channel>
```

Attributes (all required):

| Attribute | Source | Purpose |
|---|---|---|
| `source` | Auto, from MCP server name | Always `"claw-connect"`. |
| `peer` | `metadata.from` (server-injected) | Local handle of the sender. |
| `context_id` | `message.contextId` | Thread identifier. Pass back as `thread` to continue. |
| `task_id` | Adapter-minted per inbound | Per-message handle. Informational. |
| `message_id` | `message.messageId` | Sender's dedup id. Informational. |

Body: concatenated text from `message.parts` (text parts only initially; non-text parts ignored with stderr log).

**No `in_reply_to`.** Threading is via `context_id` only; each message stands alone within its thread.

**No version attribute.** Tag shape and INSTRUCTIONS string ship together in the adapter; future renames are breaking changes scoped to the adapter version, which is fine.

## MCP tool surface

Five tools. One outbound primitive. No prefix on names (Claude Code already namespaces MCP tools as `mcp__<server>__<tool>`).

| Tool | Args | Returns |
|---|---|---|
| `send` | `peer: string`, `text: string`, `thread?: string` | `{context_id, message_id}` |
| `list_peers` | — | `{peers: [{handle}]}` |
| `whoami` | — | `{handle}` |
| `list_threads` | `peer?: string`, `limit?: number` | `{threads: [{context_id, peer, last_message_at, message_count}]}` |
| `thread_history` | `thread: string`, `limit?: number` | `{messages: [{message_id, from, text, sent_at}]}` |

`list_threads` and `thread_history` read from the in-memory thread store. They never query peers. A peer that didn't implement A2A `tasks:list` is still fully usable; we just see what flowed through us.

**INSTRUCTIONS string** (sent to Claude at MCP server registration):

> This MCP server connects you to peer agents over the claw-connect network. Inbound messages arrive as `<channel source="claw-connect" peer="..." context_id="..." task_id="..." message_id="...">` events. To respond, call `send` with `thread=<context_id>` from the tag — there is no separate reply tool. To start a new conversation, call `send` without `thread`. Use `list_peers` before sending; never guess handles. Use `list_threads` when interleaving multiple peers, and `thread_history` to re-load context after a gap.

**Removed from current surface:**
- `claw_connect_reply` — there is no reply primitive. `send` covers all outbound.
- `claw_connect_*` prefix on all tool names — Claude Code namespaces automatically.

## Error handling

- **Outbound `send` failures**: return structured `isError: true` MCP tool result with a recovery hint matching the existing failure-mode messages. Never throw. Failure modes: daemon down, peer not registered, peer adapter unreachable, mTLS mismatch, other.
- **Inbound validation failures**: 400 with A2A error envelope. No channel event emitted. stderr log.
- **Server failures**: A2A error envelope to caller. stderr log. Process keeps serving.
- **Store overflow**: silent eviction by `last_activity`. No user-facing error.
- **Notification emission failures**: stderr log. Inbound HTTP request still acked (message recorded). No retry; Claude can re-fetch via `thread_history` if reconnected.

Explicit non-goals: no retry/backoff in send; no dead-letter queue; no persistent error log.

## Testing strategy

Four layers mirroring the architecture.

1. **Adapter unit tests** (vitest, no network): channel event mapping, outbound build, in-memory store semantics + eviction, MCP tool dispatch, error result shapes.
2. **Adapter integration** (vitest, real HTTP, mock relay): symmetric round-trip with `context_id` reuse; either-side initiation; structured error returns on relay failure.
3. **claw-connect server** (vitest): `X-Agent` validation; mTLS path with `X-Sender-Agent` and remote→local handle translation via `remotes.toml`; body pass-through except `metadata.from`.
4. **End-to-end** (real daemon + adapter subprocesses): three-peer interleaving with correct `peer` attribution; thread continuation; `list_threads` accuracy; structured error on dead peer; ephemeral-store contract (empty after restart).

Removed tests: `claw_connect_reply` flow, `PendingRegistry` timeout, sync request-response correlation.

## Migration

Breaking changes to the public surface:
- `claw_connect_reply` tool removed.
- `claw_connect_send` semantics changed (returns ack, no longer awaits reply via channel event).
- All MCP tool names lose `claw_connect_` prefix.
- Channel tag gains `peer`, `context_id`, `message_id` attributes.

Internal removals:
- `PendingRegistry`, the 10-minute reply timeout, the loop-the-HTTP-response trick.
- `outbound.ts` correlation logic.
- `--reply-timeout` CLI flag (if present).

Wire-level (A2A) changes are zero — we're using only spec primitives.

`server.toml` and `remotes.toml` shapes unchanged. `claude-code:start` orchestration unchanged. `.mcp.json` shape unchanged.

## What this design intentionally leaves open

- **Group messaging.** Future spec. Will likely use `contextId` shared across N peers, with claw-connect fan-out.
- **Peer presence / status.** Future spec, custom A2A extension.
- **Richer message parts** (file/data parts). Adapter currently text-only; richer parts are additive.
- **Cross-session thread persistence.** If a real need surfaces, the in-memory store can grow a JSONL-backed mode. For now, ephemeral matches the session boundary.
- **Streaming replies** (A2A `tasks/stream`). Additive; no impact on this design.

## Why each major decision

- **`contextId` as thread, not `taskId` continuation:** A2A tasks have terminal states; reusing them across a long conversation requires keeping them non-terminal, which is awkward and asymmetric. `contextId` is the spec's "thread" primitive and gives us symmetry for free.
- **Fire-and-forget over sync request-response:** The current sync-await on HTTP forces asymmetric roles (initiator waits, responder must reply). Async push matches A2A's task model and the channels mental model (events arrive, agent reacts).
- **Server-injected `metadata.from` over sender-claimed:** Identity must be authoritative. Sender-claimed identity is forgeable; server-injected (sourced from authenticated headers and mTLS) is not.
- **NAT-style local-handle namespace per host:** Each side has its own naming for peers (`remotes.toml`). The wire carries authoritative sender identifiers; the receiving server translates to the local namespace before delivery. Agents never see another host's namespace, preserving the "peer locality is opaque" invariant.
- **In-memory thread store over disk:** Adapter lifetime = session lifetime. Disk persistence buys cross-session continuity but doesn't match what users expect.
- **No tool name prefix:** Claude Code auto-namespaces MCP tools. Our prefix would double-prefix.
- **No version attribute on channel tag:** Adapter and INSTRUCTIONS ship together. Forward changes are additive; renames are breaking but scoped to one adapter version.
