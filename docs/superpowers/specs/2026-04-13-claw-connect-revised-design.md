# Tidepool: Revised Design Spec

A transparent A2A proxy that adds identity, trust, and access control to agent-to-agent communication.

---

## Scope

Tidepool is responsible for four things:

1. **Identity** — generating and managing mTLS certs per agent
2. **Connection** — friend requests, approval, revocation
3. **Communication** — proxying A2A messages between local agents and remote agents
4. **Discovery** — finding agents via mDNS, cloud directory, or static config

Tidepool is NOT responsible for:

- What an agent does with a request (file access, model choice, tools) — that's the agent's concern
- Message persistence — there is none
- Topic or subject filtering — agent expertise is natural language on the Agent Card
- Multi-agent routing logic — the A2A `tenant` field handles this natively

### Core Principle: Transparent A2A Proxy

Tidepool is A2A in, A2A out. It never transforms payloads. Both the local interface (agents on localhost) and the public interface (remote peers over mTLS) speak standard A2A. Agents don't know Tidepool exists — they just see A2A peers.

Any A2A-compatible agent can register with Tidepool, not just OpenClaw. If A2A evolves (new message types, streaming modes, task states), they pass through automatically.

---

## Model

**Agents are the entities. Servers are infrastructure.**

- Multiple agents register with one Tidepool server
- Peers address agents directly using A2A's `tenant` field — they don't address servers
- Each agent has its own identity (cert + fingerprint), Agent Card, and description
- Discovery returns agents, not servers
- Connections (friends) are managed at the server level but addressed to specific agents

### How Tenant Routing Works

A2A v1.0 natively supports multi-tenant servers. Every request can include a `tenant` parameter, and URLs support `/{tenant}/message:send`. Tidepool uses this directly:

```
POST https://bob.example.com:9900/rust-expert/message:send
POST https://bob.example.com:9900/code-reviewer/message:send
```

Both are standard A2A URLs. Any A2A client supports this. No custom routing needed.

---

## Identity

**Every agent has its own identity, independent of the server.**

- **Cert fingerprint (SHA-256)** — canonical machine identity. Unforgeable, unique, derived from the agent's self-signed certificate.
- **Handle** — human-readable display name. Locally unique (unique within your config), not globally unique. Like contacts in a phone — you name them whatever you want.
- **Endpoint** — the server URL + tenant. How you reach the agent over the network.

On the network, agents are identified by cert fingerprint. Handles are local nicknames. When you discover a remote agent and friend it, you assign your own local handle.

### Certificate Lifecycle

- Generated during `tidepool register` — self-signed, no expiry in v1
- Private key never leaves the machine
- If compromised: regenerate cert, re-establish friendships manually
- Key rotation protocol is a v2 concern

### mTLS Verification

- **First contact** (connection request): `rejectUnauthorized: false`. The server accepts any cert because the peer is unknown. The handshake establishes trust — on approval, the cert fingerprint is stored.
- **After friendship**: every request, the server extracts the cert fingerprint from the TLS handshake and verifies it matches what's stored in `friends.toml`. Mismatch → `401`.
- This is certificate pinning — stronger than CA-based trust for P2P because there's no third party to compromise.

### Storage

```
~/.tidepool/
├── server.toml              # Server config (port, global rate limit)
├── friends.toml             # Server-level friends list
└── agents/
    ├── rust-expert/
    │   ├── identity.key     # Private key
    │   ├── identity.crt     # Self-signed cert
    │   └── agent-card.json  # A2A Agent Card
    └── code-reviewer/
        ├── identity.key
        ├── identity.crt
        └── agent-card.json
```

---

## Friends

Friends are a server-level concept. A friend is an agent whose cert fingerprint you've approved. Friends can talk to all agents on your server (default) or be scoped to specific agents.

```toml
# friends.toml

[friends.alice-agent]
fingerprint = "sha256:a3f8b2c4d5e6f7a8b9c0d1e2f3a4b5c6"

[friends.carols-ml]
fingerprint = "sha256:9c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f"
agents = ["rust-expert"]
```

- Handle is the TOML key — locally unique, chosen by you
- Fingerprint is the real identity — used for mTLS verification
- `agents` is optional — omit for access to all agents, include to scope
- Friends stay forever until removed. No expiry in v1.

---

## Rate Limiting

Two layers:

1. **Server-level** — protects the machine. "This server handles at most N requests/hour total." One token bucket for all inbound requests.
2. **Per-agent** — protects that agent's compute. "rust-expert handles at most N requests/hour." One token bucket per registered agent.

No per-friend rate limits. Rate limit counters reset on server restart — rate limiting is a courtesy mechanism, not a security boundary.

```toml
# server.toml

[server]
port = 9900
host = "0.0.0.0"
rate_limit = "100/hour"

[agents.rust-expert]
local_endpoint = "http://localhost:18800"
rate_limit = "50/hour"
description = "Expert in Rust and systems programming"

[agents.code-reviewer]
local_endpoint = "http://localhost:18801"
rate_limit = "30/hour"
description = "Code review and best practices"
```

---

## Middleware Pipeline

Every inbound request on the public interface:

```
Inbound A2A request over mTLS
  → Server rate limit ok?                No → 429 with Retry-After
  → Cert fingerprint in friends.toml?    No → CONNECTION_REQUEST? → handshake handler
                                              Otherwise → 401
  → Which tenant (agent) addressed?      Unknown → 404
  → Agent rate limit ok?                 No → 429 with Retry-After
  → Friend scoped to specific agents?    Yes + agent not in list → 403
  → Forward A2A to agent's local_endpoint
```

### Error Responses

All errors are standard A2A task responses where possible:

| Situation | Response |
|-----------|----------|
| Unknown cert, not a connection request | `401 Unauthorized` |
| Friend, but scoped and agent not in list | `403 Forbidden` |
| Agent doesn't exist on this server | `404 Not Found` |
| Server or agent rate limit hit | `429 Too Many Requests` + `Retry-After` |
| Agent timeout (OpenClaw didn't respond) | A2A task with `TASK_STATE_FAILED` |
| Connection request denied | A2A task with `TASK_STATE_REJECTED` |

---

## Communication Flow

### Full Path

```
Local agent                         Remote agent
    │                                    ▲
    │ A2A (localhost)                    │ A2A (localhost)
    ▼                                    │
Local Tidepool ──── mTLS ────► Remote Tidepool
                    A2A (internet)
```

Every arrow is standard A2A. Tidepool is invisible to both agents.

### Outbound (your agent asking a remote peer)

1. Your local agent fetches Agent Cards from Tidepool's local interface
2. Sees "bobs-rust" as an available remote agent with description and skills
3. Sends standard A2A `SendMessage` to `http://localhost:9900/bobs-rust/message:send`
4. Tidepool maps the local handle "bobs-rust" to the remote endpoint and tenant: `https://bob.example.com:9900/rust-expert/message:send`
5. Attaches the local agent's mTLS cert
6. Forwards the A2A request unchanged (only the URL changes — local handle → remote tenant)
7. Response flows back as A2A through the same path

**Handle mapping:** On the local interface, Tidepool uses your local handles as A2A tenants. On the public interface, it uses the registered agent names as tenants. Tidepool maintains the mapping between local handles and remote endpoint+tenant pairs.

### Inbound (a remote peer asking your agent)

1. A2A request arrives over mTLS on the public interface
2. Middleware pipeline: server rate limit → friend check → agent lookup → agent rate limit → scope check
3. Forward A2A to agent's `local_endpoint`
4. Agent processes the request (using its own model, tools, files — Tidepool doesn't know or care)
5. Response flows back as A2A

### What Gets Stored After an Exchange

Nothing. The exchange is ephemeral. The only durable state is `server.toml`, `friends.toml`, and agent identity files — unchanged by any request.

### Streaming

`SendStreamingMessage` returns an SSE stream. Tidepool proxies the stream transparently:

```
Local agent → SSE → Local CC → SSE over mTLS → Remote CC → SSE → Remote agent
```

Tidepool doesn't buffer, transform, or add to stream chunks. If the stream breaks (network drop, timeout), both ends are closed. If `timeout_seconds` passes with no data, the server sends `TASK_STATE_FAILED` and closes the stream.

---

## Connection Handshake

The handshake is how a stranger becomes a friend. When an unknown agent sends a `CONNECTION_REQUEST`, the server decides what to do.

### Modes

```toml
# server.toml

[connection_requests]
mode = "auto"    # "accept" | "deny" | "auto"
```

- **`accept`** — auto-approve all connection requests. Good for open/demo agents.
- **`deny`** — reject all. Friends can only be added via CLI.
- **`auto`** — an LLM evaluates each request and decides.

### Auto Mode Config

```toml
[connection_requests]
mode = "auto"

[connection_requests.auto]
model = "claude-sonnet-4-6"
api_key_env = "ANTHROPIC_API_KEY"
policy = """
Accept connections from agents who have a clear reason
and seem like legitimate agents, not spam.
"""
```

### Wire Format

Connection requests use standard A2A with a Tidepool extension.

**Request:**

```json
{
  "message": {
    "messageId": "uuid",
    "role": "ROLE_USER",
    "parts": [{"kind": "text", "text": "CONNECTION_REQUEST"}],
    "extensions": ["https://tidepool.dev/ext/connection/v1"],
    "metadata": {
      "https://tidepool.dev/ext/connection/v1": {
        "type": "request",
        "reason": "Learning Rust error handling patterns",
        "agent_card_url": "https://alice.example.com:9900/alice-dev/.well-known/agent-card.json"
      }
    }
  }
}
```

The requesting agent's cert fingerprint is extracted from the mTLS handshake, not included in the payload.

**Accepted response:**

```json
{
  "id": "task-uuid",
  "status": {"state": "TASK_STATE_COMPLETED"},
  "artifacts": [{
    "artifactId": "connection-result",
    "parts": [{"kind": "text", "text": "Connection accepted"}],
    "metadata": {
      "https://tidepool.dev/ext/connection/v1": {
        "type": "accepted"
      }
    }
  }]
}
```

**Denied response:**

```json
{
  "id": "task-uuid",
  "status": {"state": "TASK_STATE_REJECTED"},
  "artifacts": [{
    "artifactId": "connection-result",
    "parts": [{"kind": "text", "text": "Connection denied"}],
    "metadata": {
      "https://tidepool.dev/ext/connection/v1": {
        "type": "denied",
        "reason": "Not accepting connections at this time"
      }
    }
  }]
}
```

### Bootstrap Problem

Unknown agents need to send connection requests, but the server normally rejects unknown certs. Connection requests are the exception:

```
Inbound request with mTLS cert
  → Cert fingerprint in friends? → normal flow
  → Not a friend → is this a CONNECTION_REQUEST?
      → Yes → route to connection mode handler
      → No  → 401 Unauthorized
```

### What Happens on Approval

1. Server extracts the requesting agent's cert fingerprint from the TLS handshake
2. Fetches the requester's Agent Card from the URL in the request metadata
3. Writes a new entry to `friends.toml` with the fingerprint and a handle derived from the Agent Card `name` field (e.g., "alice-dev"). If the name collides with an existing friend, appends a suffix (e.g., "alice-dev-2").
4. Returns the accepted response
5. The requesting side stores the remote agent's info with a local handle (prompted via CLI, or auto-derived from the Agent Card name)

Friendships are unidirectional by default. Alice friending Bob doesn't give Bob access to Alice. Bob would need to send his own connection request.

---

## Discovery

Discovery is pluggable. Multiple providers run simultaneously and return the same shape:

```typescript
interface DiscoveredAgent {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  status: 'online' | 'offline';
}
```

No cert fingerprint in discovery results. Fingerprints are exchanged during the connection handshake, not at discovery time.

### Built-in Providers

**1. mDNS / DNS-SD** — zero-config local network discovery. Uses `_a2a._tcp` service type.

```toml
[discovery.mdns]
enabled = true
```

**2. Cloud directory** — REST API for finding agents across the internet.

```toml
[discovery.directory]
enabled = true
url = "https://directory.tidepool.dev"
```

Registration requires the agent's mTLS cert. The directory stores the cert fingerprint alongside the entry. Only the cert holder can update or remove their registration. Prevents impersonation.

API:

```
POST /v1/agents/register    (mTLS required)
GET  /v1/agents/search?q=rust&status=online
GET  /v1/agents/:handle
POST /v1/agents/heartbeat   (mTLS required)
```

**3. Static config** — manual entries for known peers.

```toml
[discovery.static.peers.bob-rust]
endpoint = "https://bob.example.com:9900"
agent_card_url = "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json"
```

### How Providers Compose

All providers run simultaneously. Results are deduplicated by endpoint URL.

```toml
[discovery]
providers = ["static", "mdns", "directory"]
cache_ttl_seconds = 300
```

Discovery results are cached in memory (ephemeral). The cache prevents hammering the directory or flooding the network with mDNS queries.

### Discovery → Handshake → Communication

```
Discovery: "Found rust-expert at https://bob.example.com:9900"
  → Connection request sent for tenant rust-expert
  → Bob's server approves → adds fingerprint to friends.toml
  → Your server stores remote agent info locally
  → Local Agent Card now includes the remote agent
  → Your agents can talk to it via standard A2A
```

---

## CLI

```bash
# Server setup
tidepool init                              # Create ~/.tidepool/, generate server.toml
tidepool start                             # Start the server
tidepool status                            # Show server status, registered agents, friend count

# Register agents
tidepool register \
  --name "rust-expert" \
  --description "Expert in Rust and systems programming" \
  --endpoint "http://localhost:18800"
# This single command:
#   1. Generates a cert + private key for the agent
#   2. Creates the Agent Card
#   3. Registers the agent with the Tidepool server
#   4. Optionally publishes to the cloud directory

tidepool unregister rust-expert
tidepool agents                            # List registered agents

# Friends
tidepool friends                           # List all friends
tidepool friends add \
  --handle "alice-agent" \
  --fingerprint "sha256:a3f8..."               # Manual add, access to all agents
tidepool friends add \
  --handle "carols-ml" \
  --fingerprint "sha256:9c1d..." \
  --agents rust-expert                         # Scoped to specific agent
tidepool friends remove alice-agent

# Discovery
tidepool search "rust systems programming"
tidepool search --local                    # mDNS only

# Connection requests (from discovery results or direct URL)
tidepool connect <agent-card-url>          # Send connection request to a discovered agent
tidepool connect --url https://bob.example.com:9900/rust-expert  # Direct URL
tidepool requests                          # View pending inbound requests (mode=deny)

# Testing
tidepool ping <handle>                     # Check if reachable
```

---

## Relationship to A2A v1.0

Tidepool is built entirely on A2A v1.0 standards:

| A2A concept | How Tidepool uses it |
|-------------|-------------------------|
| Agent Card | Each registered agent has one. Remote agents are synthesized as Agent Cards on the local interface. |
| Tenant | Maps to registered agents. `/{tenant}/message:send` routes to the right agent. |
| SendMessage | Proxied unchanged in both directions. |
| SendStreamingMessage | SSE streams proxied transparently. |
| Task states | `TASK_STATE_REJECTED` for denied connection requests. `TASK_STATE_FAILED` for timeouts. |
| MutualTlsSecurityScheme | Declared in Agent Card security schemes. Cert fingerprint is the identity. |
| Extensions | `https://tidepool.dev/ext/connection/v1` for connection handshake messages. |

The only Tidepool-specific addition to A2A is the connection handshake extension. Everything else is standard A2A.

---

## Implementation Phases

### Phase 1: Single-machine proof of concept

**Goal:** Two agents on one machine talk through two Tidepool servers.

- Build the Tidepool server (Express + A2A SDK)
- `tidepool init` and `tidepool register`
- mTLS on the public interface
- Hardcode friends (skip handshake)
- Local interface serves Agent Cards for remote agents
- Tenant-based routing
- Test: agent A → A2A → CC-A → mTLS → CC-B → A2A → agent B → response flows back

**Validates:** the core A2A proxy model works end to end.

### Phase 2: Friends and handshake

**Goal:** Agents can request, approve, and remove friends.

- `friends.toml` with fingerprint verification
- Connection handshake (CONNECTION_REQUEST extension)
- Three modes: `accept`, `deny`, `auto`
- `tidepool friends add/remove/list`
- `tidepool connect`
- `tidepool requests`

**Validates:** trust model works. Unknown agents are rejected. Friends get through.

### Phase 3: Rate limiting and error handling

**Goal:** Server and agent rate limits, proper A2A error responses.

- Server-global token bucket
- Per-agent token bucket
- `429` with `Retry-After`
- `TASK_STATE_REJECTED` for non-friends
- `TASK_STATE_FAILED` for agent timeout
- Configurable timeout per agent

**Validates:** the server protects itself under load.

### Phase 4: Discovery

**Goal:** Agents can find each other without knowing endpoints in advance.

- Pluggable discovery interface
- mDNS / DNS-SD provider
- Cloud directory provider (Convex-backed, cert-authenticated)
- Static config provider
- `tidepool search`
- Discovery results feed into `tidepool connect`

**Validates:** full discovery → handshake → communication flow end to end.

### Phase 5: Streaming and polish

**Goal:** Long-running requests stream properly, CLI is complete.

- SSE stream passthrough for `SendStreamingMessage`
- `tidepool status` dashboard
- `tidepool ping`
- Rich Agent Card synthesis on local interface

**Validates:** production-ready for real use.

### Future (beyond v1)

- NAT traversal (STUN/TURN)
- Key rotation protocol
- Per-friend agent scoping enforcement
- Multi-hop routing
- Token economics / credits
- Clawcast integration — peer connections graduate into podcast episodes

---

## Design Decisions

| Decision | Alternative | Why |
|----------|------------|-----|
| Transparent A2A proxy | Custom protocol or translation layer | Both interfaces are pure A2A. Protocol evolves without Tidepool changes. Any A2A agent works, not just OpenClaw. |
| Agents are entities, servers are infrastructure | Server-centric model | Peers address agents, not servers. Multiple agents register with one server. Matches how people think about it. |
| A2A tenant for multi-agent routing | Custom URL paths or payload fields | Tenant is A2A's native multi-agent mechanism. Standard, no extensions needed. |
| Cert fingerprint as identity | Handles, URLs, API keys | Cryptographic, unforgeable, unique. Handles are local nicknames. |
| Friends list (server-level) | Per-agent connection tracking | Simple. One list, checked on every request. Friends can be scoped to agents if needed. |
| Server + per-agent rate limits | Per-friend rate limits | Simpler. Protects the machine and each agent's compute without tracking every pair. |
| No topic/subject filtering | Keyword or LLM-based topic matching | Agent description is natural language. File access is the agent's concern, not the proxy's. |
| No message persistence | SQLite, message history | This is tool calling, not messaging. Ephemeral by design. |
| Self-signed certs, no expiry (v1) | CA-signed, expiring certs | Simple for v1. No CA infrastructure. Key rotation is v2. |
| Certificate pinning after handshake | CA-based trust | Stronger for P2P — no third party to compromise. First contact establishes trust, then fingerprint is verified. |
| TOML config | SQLite, JSON, YAML | Human-readable, easy to edit, easy to version control, one file. |
| Build own server, reference gateway | Fork or proxy to openclaw-a2a-gateway | Gateway has no middleware hooks, bundles features we don't need. We reference its OpenClaw bridge code but build a focused A2A proxy. |

---

## Open Questions (reduced from original)

1. **NAT traversal**: For v1, both peers need reachable endpoints. How to handle agents behind NATs is a v2 concern.
2. **Offline peers**: If the remote agent is unreachable, the A2A request fails with a timeout. No store-and-forward in v1.
3. **Abuse prevention**: What stops someone from spamming connection requests? Rate limiting at the server level covers this partially. The `auto` mode LLM can detect spam patterns. More robust solutions (proof of work, social graph trust) are v2.
