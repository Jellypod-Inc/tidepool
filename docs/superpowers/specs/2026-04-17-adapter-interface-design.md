# Adapter interface redesign (design)

**Date:** 2026-04-17
**Status:** Approved (pending implementation plan)

## Background

The current adapter-to-daemon interface (`POST /:tenant/:action` with an `X-Agent` header, plus a statically-declared `localEndpoint` the daemon calls for inbound) grew organically. It works for the single-adapter Claude Code case, but several forces are pushing on it:

1. **Each agent framework has its own extension point.** Claude Code wants MCP-stdio. OpenClaw wants in-process channel plugins. The current interface's assumptions (agent pre-declares a port in config; daemon calls that port) break naturally for both.
2. **The local interface is a tidepool-invented shape.** `X-Agent` header, tenant-in-path, ad-hoc error responses. Anyone writing a new adapter learns tidepool's dialect even though A2A already defines the vocabulary.
3. **Two directions of asymmetry.** The public interface uses `:tenant = local agent being addressed`; the local interface uses `:tenant = remote peer being addressed`. Same URL shape, different semantics.
4. **The DHT / DID work (task 04) is coming.** We want an adapter contract that doesn't bake in any cert-fingerprint-specific assumptions.

This spec redesigns the adapter-to-daemon interface around one principle: **speak standard A2A everywhere, with the smallest-possible tidepool extension for the things A2A doesn't cover.**

## Non-goals

- **Running agents out-of-process on a remote host.** "Adapter on machine A, daemon on machine B" is a hosted-mode concern; v1 is local-only.
- **Multi-agent adapter processes.** One adapter process = one agent identity. If you want N agents, spawn N processes.
- **Windows support.** We target macOS and Linux. Port-based transport makes Windows workable later, but we're not testing it.
- **Bearer-token auth.** We explicitly defer this to a later design; v1 uses Origin/Host checks + SSE session exclusivity. THREATS.md documents the limitation.
- **Task-based coordination between peers.** tidepool's prose-only principle stands: `tasks/*` methods are stubbed with `UnsupportedOperationError`.

## Guiding principles

1. **Prose at the agent layer, full A2A at the wire.** The agent (LLM) sees prose only. Adapters translate between prose and full A2A `Message` objects. Everything below the adapter preserves A2A fidelity (contextId, extensions, parts, metadata, streaming granularity).
2. **A2A is the local contract.** The daemon's local HTTP interface is a valid A2A server. Any A2A client library can talk to it. Any A2A agent runtime (hosting an A2A server) can receive from it.
3. **Tidepool extensions live under `.well-known/tidepool/*`.** The `.well-known` prefix (RFC 8615) keeps non-A2A routes out of the handle namespace. When A2A adds new methods, they slot in at `/{handle}/{new-method}` without extension-namespace conflicts.
4. **Unified URL shape on both interfaces.** `/{handle}/...` always means "A2A agent addressed by this handle." The set of resolvable handles differs (local agents on public, friends on local) but the shape is identical.
5. **Identity is runtime, not config.** Adapter registers its endpoint at session open; daemon discards it when the session closes. No stale config files, no dangling port declarations.
6. **Session = registration = liveness = identity.** One long-lived SSE connection carries all three. Its existence proves the adapter is running; its uniqueness proves the adapter is authoritative for its handle.

## Architecture

Three layers, with the adapter as the boundary between prose-world and A2A-world:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Agent  (LLM / reasoning loop)                                       │
│   Sees prose. Addresses peers by handle. No awareness of A2A,       │
│   contextId, parts, extensions, DID.                                │
└────────────────────────────┬────────────────────────────────────────┘
              framework-specific binding (MCP tools, channel plugin, ...)
┌────────────────────────────┴────────────────────────────────────────┐
│ Adapter  (framework glue; one process = one agent identity)         │
│   • Holds SSE session with daemon (registration + liveness + ctrl)  │
│   • A2A client for outbound: POST to daemon's local A2A interface   │
│   • A2A server for inbound: hosts its own loopback HTTP server      │
│   • Translates between agent-facing prose API ↔ full A2A Messages   │
└────────────────────────────┬────────────────────────────────────────┘
                  localhost TCP (ephemeral ports, loopback-bound)
┌────────────────────────────┴────────────────────────────────────────┐
│ Tidepool Daemon                                                     │
│   • Full A2A transport fidelity (contextId, parts, extensions, ...) │
│   • mTLS + friend trust (today) / DID-resolved keys (task 04)       │
│   • Exposes A2A agent endpoints at /{handle}/... on both interfaces │
│   • .well-known/tidepool/* for tidepool extensions (registry, etc.) │
└─────────────────────────────────────────────────────────────────────┘
```

## URL surface

Both the public (mTLS) and local (loopback HTTP) interfaces expose the same shape.

### A2A-standard routes (both interfaces)

```
GET  /{handle}/.well-known/agent-card.json
POST /{handle}/message:send
POST /{handle}/message:stream           (SSE response, if capability advertised)
GET  /{handle}/tasks/{id}               (stub — returns UnsupportedOperationError)
GET  /{handle}/tasks                    (stub — returns UnsupportedOperationError)
POST /{handle}/tasks/{id}:cancel        (stub — returns UnsupportedOperationError)
```

On the **public** interface, `{handle}` names a locally-registered agent. On the **local** interface, `{handle}` names a friend.

### Tidepool extensions (local interface only)

```
GET  /.well-known/tidepool/peers                    # directory of friends
POST /.well-known/tidepool/agents/{name}/session    # register + SSE stream
```

Nothing else. The public interface has no tidepool-extension routes; it's pure A2A from outside.

### Stub handlers for A2A mandatory methods

A2A 1.0 flags `tasks/get`, `tasks/list`, `tasks/cancel` as MUST. tidepool's prose-only design doesn't support tasks, but we can't remove the endpoints without failing A2A conformance. Solution: implement each as a spec-compliant error response (`UnsupportedOperationError`, JSON-RPC code -32006, HTTP 405). Both the daemon (for public-interface requests) and the adapter (for inbound requests that reach it via the daemon's proxy) must stub these.

## Registration + liveness (SSE session)

### Flow

1. Adapter boots, binds its inbound A2A server to `127.0.0.1:0` (OS picks ephemeral port), reads back the actual port.
2. Adapter issues:
   ```
   POST http://127.0.0.1:<daemon-port>/.well-known/tidepool/agents/alice/session
   Origin: http://127.0.0.1:<daemon-port>
   Content-Type: application/json
   Accept: text/event-stream

   {
     "endpoint": "http://127.0.0.1:54312",
     "card": {
       "description": "Claude Code coding assistant",
       "skills": [...],
       "capabilities": { "streaming": false, "extensions": [] },
       "defaultInputModes": ["text/plain"],
       "defaultOutputModes": ["text/plain"]
     }
   }
   ```
3. Daemon validates:
   - Origin check passes (see "Security posture" below)
   - `alice` is a registered agent name (via `tidepool agent create alice`)
   - No other adapter currently holds alice's session
4. Daemon responds `200 OK` with `Content-Type: text/event-stream` and keeps the connection open.
5. Daemon merges the adapter-supplied `card` fragment with its own transport fields (`supportedInterfaces`, `securitySchemes`, `name`, `provider`, `signatures`) to produce alice's public agent card.
6. Daemon emits initial events on the stream:
   ```
   event: session.registered
   data: {"sessionId":"<uuid>"}

   event: peers.snapshot
   data: [{"handle":"bob","did":null},{"handle":"charlie","did":null}]
   ```
7. Daemon re-emits `peers.snapshot` any time the friend set changes (add/remove/rename).
8. Standard SSE keepalives (`: ping\n\n` comment lines) every 15s.

### Termination

- **Adapter closes the stream** (graceful shutdown): daemon immediately marks alice offline; slot freed for the next registration.
- **TCP connection drops** (adapter crash, OS kill): daemon detects via socket close; same cleanup.
- **Keepalive timeout** (adapter alive but network stalled): daemon closes the stream after two missed keepalives (~30s). Same cleanup.

No persistence of `endpoint` across disconnect. Reconnect = full re-registration with a fresh endpoint URL (adapter's ephemeral port is re-bound on each start).

### Conflict

If a second adapter POSTs to alice's session while the first is connected, the second request gets:
```
HTTP/1.1 409 Conflict
Content-Type: application/json

{ "error": { "code": "session_conflict",
             "message": "agent 'alice' already has an active session",
             "hint": "Check if another adapter process is running. Use `tidepool status` to see registered agents." } }
```

First-come-first-served. Take-over semantics are explicitly rejected for v1 — if a user wants to transfer, they kill the first process.

### Minimum event set (v1)

| Event | Purpose | Payload |
|-------|---------|---------|
| `session.registered` | Initial ack after successful registration | `{ sessionId }` |
| `peers.snapshot` | Current friend list; sent on register and on any change | Array of `{ handle, did }` |

That's it. No `peer.online`, no `peer.offline`, no card update events. Adapters refresh from snapshots; the daemon never has to reconcile incremental change deltas.

Future events (deferred): peer DID rotation notices, in-band peer reachability signals once tidepool has real data on them.

## Data flow

### Outbound (adapter → remote peer)

```
adapter:    constructs A2A Message (messageId, contextId?, parts, metadata?, extensions?)
adapter  →  POST http://127.0.0.1:<daemon-port>/bob/message:send
            Content-Type: application/json
            Origin: http://127.0.0.1:<daemon-port>
            { "message": {...} }

daemon:     validates Origin, resolves "bob" in friends, looks up bob's endpoint,
            opens mTLS to bob's daemon using pinned cert (or DID-resolved key later)

daemon   →  POST https://bob.host/bob/message:send  (over mTLS)
            Content-Type: application/json
            { "message": {...} }

daemon   ←  A2A response (Message or Task)
adapter  ←  A2A response, verbatim
```

No shape translation in the daemon. The `Message` body flows through unchanged except for `metadata.from` being injected on bob's side when the message is delivered to bob's adapter.

### Inbound (remote peer → local adapter)

```
remote   →  POST https://alice.host/alice/message:send  (over mTLS)
            Content-Type: application/json
            { "message": {...} }

daemon:     mTLS handshake verifies remote is a known friend
daemon:     injects metadata.from = "<local-handle-for-sender>" on the message
daemon:     looks up alice's currently-registered endpoint (from SSE session)

daemon   →  POST http://127.0.0.1:54312/message:send  (adapter's ephemeral URL)
            Content-Type: application/json
            { "message": {...} }

adapter:    emits the A2A Message to its agent-facing layer (MCP notification,
            channel plugin callback, etc.)

adapter  ←  A2A response (Task in state `completed`, no reply message)
daemon   ←  same response
remote   ←  same response
```

The adapter's inbound handler sees a full A2A Message. It's the adapter's job to translate that Message into framework-specific signals (prose + metadata for the LLM, file parts → tool results, etc.). The daemon never interprets content.

## Security posture (v1)

### Controls in place

1. **Loopback binding.** Local interface listens only on `127.0.0.1`. Daemon refuses to bind to any other interface (no `--bind-all` flag).
2. **Origin/Host header check.** Every request to the local interface must have:
   - `Origin` header absent, OR `Origin` in allow-list: `http://localhost:<port>`, `http://127.0.0.1:<port>`, `null` (for non-browser clients)
   - `Host` header equal to `127.0.0.1:<port>` or `localhost:<port>`
   
   Rejected with `403 origin_denied`. Blocks browser drive-by (DNS rebinding, CSRF-style attacks from visited pages).
3. **SSE session exclusivity.** Only one adapter can register as alice at a time. An impostor process can attempt to register but will get `409 session_conflict` while the legitimate adapter holds the session.

### Known gaps (accepted for v1, documented in THREATS.md)

1. **Cross-user access on shared machines.** Any user on the machine can hit `127.0.0.1:<port>`. A bearer token would prevent this; v1 doesn't have one. Tidepool is positioned as a personal/solo-dev daemon; shared-machine deployment is not v1 scope.
2. **Sandboxed processes running as the same user.** No defense if a restricted process running as alice wants to act as alice.
3. **Accidental exposure via misconfiguration.** Mitigated by refusing to bind non-loopback, not eliminated.

Upgrade path: adding bearer tokens is strictly additive. Origin check stays, session exclusivity stays, token requirement layers on top. No breaking change.

## Agent card authorship

Hybrid — daemon owns transport fields, adapter contributes agent-specific fields, daemon merges.

| Field | Owned by | Source |
|-------|----------|--------|
| `name` | Daemon | From `tidepool agent create <name>` |
| `provider` | Daemon | Daemon config |
| `supportedInterfaces` | Daemon | Computed from current daemon endpoints |
| `securitySchemes` | Daemon | mTLS today; DID + mTLS after task 04 |
| `signatures` | Daemon | Signed with daemon's identity key |
| `description` | Adapter | Registration payload |
| `skills` | Adapter | Registration payload |
| `capabilities.streaming` | Adapter | Registration payload |
| `capabilities.extensions` | Adapter | Registration payload |
| `defaultInputModes` | Adapter | Registration payload |
| `defaultOutputModes` | Adapter | Registration payload |
| `iconUrl`, `documentationUrl` | Adapter | Registration payload (optional) |

When a remote peer fetches `GET /{handle}/.well-known/agent-card.json` on the public interface, the daemon returns the merged card. If the adapter is not currently registered, the daemon returns `503 agent_offline`.

## Error model

### Response shape

Every non-2xx response from either interface uses this body:

```json
{
  "error": {
    "code": "<stable-identifier>",
    "message": "<human-readable>",
    "hint": "<actionable-suggestion>"
  }
}
```

`code` is stable; adapters switch on it. `message` and `hint` are UX copy; never pattern-matched in code.

### Code taxonomy (tidepool-specific)

| HTTP | code | Meaning |
|------|------|---------|
| 400 | `invalid_request` | Malformed body, missing required fields |
| 403 | `origin_denied` | Origin/Host check failed |
| 404 | `peer_not_found` | Handle not in friends |
| 409 | `session_conflict` | Another adapter holds this agent's session |
| 502 | `peer_unreachable` | Remote daemon refused TCP connection |
| 503 | `agent_offline` | Remote daemon up, but named agent not registered there |
| 504 | `peer_timeout` | Remote didn't respond within `timeoutSeconds` |

### A2A-defined errors (forwarded or emitted in A2A envelope)

Where A2A 1.0 specifies an error code, use A2A's JSON-RPC-style envelope:

```json
{ "jsonrpc": "2.0",
  "error": { "code": -32006, "message": "Operation not supported", "data": {...} },
  "id": "<messageId>" }
```

- `UnsupportedOperationError` (-32006, HTTP 405) — used by `tasks/*` stub handlers
- `ExtensionSupportRequiredError` (-32008, HTTP 400) — forwarded from upstream
- `VersionNotSupportedError` (-32009, HTTP 400) — version negotiation failure

### Streaming error semantics

When `message:stream` is proxied and the remote fails mid-stream, the daemon emits an A2A `TaskStatusUpdateEvent` with `status.state = "failed"` into the SSE stream (using `buildFailedStatusEvent` from `a2a.ts`), then closes. Adapter-side SSE consumers see the failure as a terminal event in-stream, not as a transport error.

## Breaking changes from current code

1. **`POST /:tenant/:action` on local interface → `POST /{handle}/{method}`.** Shape change for outbound calls. Adapters update their URL builder.
2. **`X-Agent` header → removed.** Adapter identity comes from SSE session ownership, not a header.
3. **`agent.localEndpoint` in server config → removed.** Replaced by runtime registration.
4. **`tidepool register alice --endpoint <url>` CLI → subsumed.** `tidepool agent create alice` still exists (creates the identity slot); endpoint is declared at runtime by the adapter.
5. **Agent card construction in `src/agent-card.ts` → rework.** `buildLocalAgentCard` becomes a merge of daemon-owned fields + registered adapter fragment. `buildRemoteAgentCard` proxies unchanged (just fetches remote and re-serves).
6. **Connection request extension (`CONNECTION_EXTENSION_URL`) stays.** Friending handshake is orthogonal to the adapter-interface redesign.

## Claude Code adapter migration

Scope: ~150 lines changed, no architectural rework.

| File | Change |
|------|--------|
| `adapters/claude-code/src/http.ts` | Accept full A2A Message (stop plucking `parts[0].text`); emit structured `InboundInfo` with parts array instead of flat text; add stub handlers for `tasks/get`, `tasks/list`, `tasks/cancel` returning `UnsupportedOperationError` |
| `adapters/claude-code/src/outbound.ts` | Drop `X-Agent` header; update URL builder to match new local interface shape (if the path format changes materially); error-code mapping updates for new `code` taxonomy |
| `adapters/claude-code/src/start.ts` | Add SSE session open + registration payload construction; on session close, shut down the adapter cleanly |
| `adapters/claude-code/src/channel.ts` | No change — MCP tool layer is prose-facing; A2A details live below it |
| `adapters/claude-code/src/config.ts` | `listPeerHandles` changes from config-file read to consuming `peers.snapshot` events from the SSE session (cached in-process) |

The `channel.ts` INSTRUCTIONS string and MCP tool definitions are unaffected — the agent-facing contract (send by handle, reply by context_id, list_peers) is preserved.

## Forward compatibility

### DID (task 04)

Zero impact on the adapter interface. DID changes peer trust (mTLS key resolution) and peer discovery (DHT announces), both below the adapter layer. The only surface change is that `peers.snapshot` and `GET /.well-known/tidepool/peers` will carry non-null `did` values; adapters that ignore the field continue to work.

### Bearer tokens (future)

Layered on top of the Origin check. Registration payload gains `Authorization: Bearer <token>` header; daemon validates. All other mechanics unchanged. No adapter-side code changes beyond reading the token from config + adding one header.

### Unix domain sockets (future)

Transport swap only. Registration payload's `endpoint` field accepts `unix://path/to.sock` URLs. Daemon dispatches via undici's `socketPath` (already in use for mTLS outbound, so no new dependency). No shape change to URLs, payloads, or flow.

### Multi-agent adapters (future)

Registration payload extends from `{endpoint, card}` to `{agents: [{name, endpoint, card}]}`. SSE session multiplexes control events for all hosted agents. Single-agent processes use the current (wrapped in a one-element array) or continue with the v1 shape; both coexist.

## Open questions resolved during spec review

1. **Can the SSE handshake's first message carry a JSON body?** Yes. HTTP allows POST with a response body of `text/event-stream`. The initial POST carries the registration payload; the response streams events. Several major APIs (OpenAI, Anthropic) do this for streaming completions.
2. **How does the adapter re-register after daemon restart?** It doesn't — the SSE session fails, adapter handles the error. Reconnection is the adapter's responsibility, with a backoff policy. Not specified here; each adapter picks its own.
3. **What if the daemon loses track of an adapter's registration during its own restart?** The adapter's session TCP connection is severed; adapter sees it and re-registers. No stale state.

## Acceptance criteria

- [ ] Daemon local interface serves `/{handle}/message:send` for all registered-and-online agents.
- [ ] Daemon local interface serves `GET /.well-known/tidepool/peers` returning `[{handle, did}]`.
- [ ] Daemon local interface serves `POST /.well-known/tidepool/agents/{name}/session` with SSE response, honoring Origin check and session exclusivity.
- [ ] `tasks/get`, `tasks/list`, `tasks/cancel` return `UnsupportedOperationError` on both interfaces.
- [ ] Agent card merged correctly: adapter-supplied fields override defaults; daemon-owned fields always come from daemon.
- [ ] Adapter disconnect frees the agent slot immediately; subsequent `GET /{handle}/.well-known/agent-card.json` returns `503 agent_offline`.
- [ ] Claude Code adapter passes its existing e2e tests against the new interface.
- [ ] `peers.snapshot` event fires on initial connect and any friend-set change (add via `tidepool friend add`, remove via `tidepool friend remove`).
- [ ] All error responses use the structured `{error: {code, message, hint}}` shape; `code` values are in the taxonomy above.

## Effort estimate

- Daemon: ~1 week — route reshaping, registration endpoint, SSE session, card merging, error body standardization.
- Claude Code adapter: ~2-3 days — the changes enumerated above.
- Tests: ~2-3 days — e2e tests for registration/conflict/disconnect, unit tests for card merging and error codes.

Total: ~2 weeks, one person.

## File pointers

- `src/server.ts` — route definitions for both interfaces
- `src/agent-card.ts` — agent card construction, to be reworked for merge model
- `src/middleware.ts` — extension handling, stays
- `src/identity-injection.ts` — `metadata.from` injection, stays
- `src/streaming.ts` — SSE proxy, mostly unchanged
- `src/errors.ts` — error response builders, to be updated for new taxonomy
- `src/config-holder.ts` — agent config, to be updated for runtime-registered endpoints
- `adapters/claude-code/src/` — adapter migration, per table above
- New: `src/session/` — SSE session state + registration endpoint
- New: `src/local-api.ts` — the local A2A interface + tidepool extensions (split from `server.ts` for clarity)
