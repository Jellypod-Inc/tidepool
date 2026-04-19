# Tasks

Candidate work items generated from a competitive review against Langchain-Chatchat
and ClawNet (chatchat.space). Each task is a self-contained brief suitable for
filing as a GitHub or Linear issue.

## Design principles this respects

- **Prose is the only interface between agents.** All coordination between agents
  happens in natural language inside the A2A channel. No typed RPC, no cross-peer
  tool calls, no blocking coordination primitives that hide behavior from the agent.
- **Locality is opaque to agents.** Agents hold peer handles; the daemon decides
  whether a handle is local or remote.
- **Friending is explicit and mutual.** Discovery finds candidates; trust is
  always a deliberate human (or agent-assisted) decision.

## Rejected ideas (and why)

- **Cross-peer tool federation** — would make a remote peer's tools callable as
  local MCP tools. Rejected because it bypasses prose and introduces typed RPC
  between peers, which is explicitly not what this system is.
- **Blocking swarm-reasoning primitive** (e.g. `fanout(peers, text, timeout)` that
  waits and aggregates) — already unnecessary. Multi-peer `send` + the
  `participants` list convention (see `packages/a2a-claude-code-adapter/src/channel.ts`)
  lets agents run swarms in prose today. A blocking aggregator would hide
  coordination from the agent's own reasoning — same sin as tool federation.

## Task index

Ordered roughly by effort / readiness, not priority.

| # | Task | Effort |
|---|------|--------|
| 1 | [Per-friend rate limits](./01-per-friend-rate-limits.md) | S |
| 2 | [Audit log](./02-audit-log.md) | S |
| 3 | [Streaming (`message:stream`)](./03-message-stream.md) | M |
| 4 | [DHT identity and discovery](./04-dht-identity-and-discovery.md) | L |
| 5 | [Shared knowledge layer](./06-distributed-knowledge-layer.md) | L |
| 6 | [Web dashboard](./07-web-dashboard.md) | M |
| 7 | [Framework-agnostic adapter](./08-framework-agnostic-adapter.md) | M |
| 8 | [NAT traversal and WireGuard transport](./09-wireguard-transport.md) | Phased: docs (S) → relay (M) → WireGuard (L) |
| 11 | [Thread-canonical participants + reply_all (P3)](./11-thread-canonical-participants.md) | M |
| 12 | [Outbound-dispatch helper extraction](./12-outbound-dispatch-extraction.md) | S |
