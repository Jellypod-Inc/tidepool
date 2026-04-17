# Framework-agnostic adapter

## Context

The only adapter today is `a2a-claude-code-adapter`. It binds Tidepool to
Claude Code via the experimental MCP channel capability. Non-Claude agents —
LangChain, CrewAI, AutoGen, custom Python/Go/Rust agents — cannot participate
in the mesh.

Competitor stance:

- **ClawNet** is framework-agnostic: any HTTP-capable agent can connect to the
  REST API at `localhost:3998`
- **Langchain-Chatchat** runs its own agent loop but exposes an OpenAI-
  compatible HTTP API consumable by any client

Staying Claude-Code-only is the single largest constraint on Tidepool's
addressable audience. A plain HTTP adapter unlocks every other framework
without changing the core daemon.

This does not violate the prose-only principle. The HTTP adapter is a thin
translation layer: external agent frameworks POST prose outward and receive
prose inbound via webhook or long-poll. Agents still talk to each other in
natural language; the adapter only changes how an agent process receives its
channel events.

## Proposed approach

New package `packages/a2a-http-adapter/` — sibling to the Claude Code adapter.

### Surface

- `POST http://localhost:<port>/send` — body `{peers, text, thread?}` — send
  a message; returns `{context_id, results: [...]}`
- `GET http://localhost:<port>/peers` — list reachable peers
- `GET http://localhost:<port>/threads` — list threads
- `GET http://localhost:<port>/threads/:id` — thread history
- **Inbound**: the adapter calls a user-configured webhook URL on each
  inbound A2A message: `POST <webhook> {peer, participants?, context_id,
  task_id, message_id, text}`
- Alternative inbound: `GET /inbox/stream` as SSE for clients that cannot
  host a webhook

### Config

```toml
# adapter config (separate from the daemon's server.toml)
agentName = "alice"
daemonUrl = "http://127.0.0.1:9901"
[inbound]
mode = "webhook"          # webhook | sse
webhookUrl = "http://localhost:8080/a2a-inbox"
```

### Reference integrations

As a follow-up deliverable (not part of this task): short example clients for
LangChain (Python), CrewAI (Python), and a vanilla Node client. Each example
is <100 lines and proves the round-trip.

## Acceptance criteria

- `a2a-http-adapter` runs as a standalone process and connects to a running
  daemon
- All five endpoints above behave correctly
- Webhook delivery retries with exponential backoff on 5xx / timeout
- SSE inbound stream survives reconnect via `Last-Event-ID`
- Documentation includes a minimal curl-only quickstart
- Integration test: two peers, one using the Claude Code adapter and one
  using the HTTP adapter, exchange a multi-turn conversation successfully

## Effort

Medium — ~1 week for the adapter. Reference integrations add 2 to 3 days each.

## Open questions / risks

- **Auth to the adapter**: loopback-bind by default; optional shared-secret
  header for multi-process setups on the same host
- **Webhook reliability**: if the external agent process is down, messages
  must be retried without loss. Needs a small disk-backed queue.
- **Semantics parity with the Claude Code adapter**: `participants`,
  `context_id`, and thread continuation must behave identically. Share the
  `ThreadStore` or a compatible implementation between adapters.
- **Multiple agents per adapter**: one adapter process = one agent, matching
  the Claude Code adapter's model. Operators running N agents run N adapters.

## File pointers

- `packages/a2a-claude-code-adapter/` — reference implementation
- `packages/a2a-claude-code-adapter/src/channel.ts` — tool definitions to
  mirror as HTTP endpoints
- `packages/a2a-claude-code-adapter/src/thread-store.ts` — reuse if possible
- `packages/tidepool/src/a2a.ts` — wire protocol types
