# claw-connect

Local-first [A2A](https://a2a-protocol.org) peer server. Run your own agent on your laptop, talk to friends' agents over mTLS authenticated by cert fingerprints — no CAs, no central directory, no hosted service.

Used by [`a2a-claude-code-adapter`](../a2a-claude-code-adapter) to wire Claude Code sessions into the A2A network.

---

## When to use this

- You're running one or more AI agents on your own machine and want them reachable from other people's agents without standing up public infrastructure.
- You want two AI sessions on the same laptop talking to each other (use `claude-code:start` — see below).
- You're building a new adapter (Cursor, Codex, custom) and need the peer-routing layer.

If you just want Claude Code with A2A and don't care about the internals, read [`a2a-claude-code-adapter/README.md`](../a2a-claude-code-adapter/README.md) and come back here only if something breaks.

---

## Install

```bash
npm i -g claw-connect
# or, in this monorepo:
pnpm -r build && pnpm link --global --filter claw-connect
```

Check: `which claw-connect` should print a path.

---

## Quick start — two Claude Code sessions on one machine

```bash
cd ~/proj-a && claw-connect claude-code:start alice
cd ~/proj-b && claw-connect claude-code:start bob
```

Each command sets up a home, registers the agent, writes `.mcp.json`, ensures the daemon is running, and launches Claude Code. See [`a2a-claude-code-adapter/README.md`](../a2a-claude-code-adapter/README.md) for the full walkthrough.

For everything else — running a server for external peers, friending someone on another laptop, building your own adapter — read on.

---

## Concepts

**Peer.** A claw-connect host. One identity (self-signed cert at `$CLAW_CONNECT_HOME/identity.{crt,key}`) identifies the peer to friends. The fingerprint of that cert is the public ID.

**Agent.** A named tenant route on a peer. Declared in `[agents.<name>]` in `server.toml`. Has a `localEndpoint` where its HTTP server listens (typically an adapter process). Multiple agents can live behind one peer and share the peer's wire identity.

**Friend.** A remote peer you've added by handle + fingerprint (`claw-connect friend add <handle> <fingerprint>`). Their inbound mTLS handshake is accepted because the fingerprint matches. Optionally scoped to specific local agents.

**Remote.** A shortcut that lets your local agents address a friend by a short handle (`claw-connect remote add <local-handle> https://<their-ip>:9900 <their-agent> <their-fingerprint>`). Outbound messages to `<local-handle>` are proxied over mTLS to that peer.

**Trust model.** Self-signed certs; friendship is fingerprint pinning. No CAs, no revocation, no directory. Adding a friend is a manual step on both sides. If someone steals your key file, they're you on the network — treat `$CLAW_CONNECT_HOME/identity.key` like an SSH private key.

---

## Command reference

### Lifecycle

| Command | Purpose |
|---|---|
| `claw-connect init` | Create `$CLAW_CONNECT_HOME` with an empty config and a fresh peer identity. Idempotent. |
| `claw-connect register <name>` | Add an agent tenant to this peer's `server.toml`. Requires `--local-endpoint http://127.0.0.1:<port>`. |
| `claw-connect serve` | Start the peer server in the foreground. Ctrl+C to stop. |
| `claw-connect claude-code:start [agent]` | One-shot: init (if needed), pick a name + port (if no arg + no existing `.mcp.json`), register, write `.mcp.json` in cwd, spawn `serve` as a background daemon, exec `claude`. `--debug` skips daemonizing and printing launch instructions; runs serve in the foreground. |
| `claw-connect stop` | Stop the background daemon started by `claude-code:start`. SIGTERM, 2 s grace, then SIGKILL. |
| `claw-connect status` | Print config summary + daemon state (running/not, PID if running). |

### Identity & directory

| Command | Purpose |
|---|---|
| `claw-connect whoami` | Print the peer fingerprint and the list of agents. |
| `claw-connect ping <url>` | Fetch an Agent Card from a URL and report reachability. Useful for sanity-checking a remote before friending. |

### Friends (people who can reach you)

| Command | Purpose |
|---|---|
| `claw-connect friend add <handle> <fingerprint>` | Trust a remote peer by handle + SHA-256 fingerprint. Use `--scope <agent> [<agent>…]` to restrict what they can reach. |
| `claw-connect friend list` | Show all trusted friends. |
| `claw-connect friend remove <handle>` | Stop trusting. |

### Remotes (peers you can reach)

| Command | Purpose |
|---|---|
| `claw-connect remote add <localHandle> <remoteEndpoint> <remoteTenant> <certFingerprint>` | Register a short-name alias for a friend's agent so you can POST to `/<localHandle>/message:send` locally. |
| `claw-connect remote list` | Show all remotes. |
| `claw-connect remote remove <localHandle>` | Remove. |

### Directory (optional)

| Command | Purpose |
|---|---|
| `claw-connect directory serve` | Run a standalone directory server (for peer discovery in closed groups). |

---

## On-disk layout

```
$CLAW_CONNECT_HOME/
├── identity.crt        ← peer cert (public; share its fingerprint, never the file)
├── identity.key        ← peer private key (0600 permissions; DO NOT SHARE)
├── server.toml         ← [server] + [agents.*] + [connectionRequests] + [discovery] + [validation]
├── friends.toml        ← [friends.<handle>] fingerprint, optional agents scope
├── remotes.toml        ← [remotes.<localHandle>] remoteEndpoint, remoteTenant, certFingerprint
├── serve.pid           ← PID of background daemon (present only when daemonized)
└── logs/
    └── serve-YYYY-MM-DD.log   ← stdout/stderr of the daemonized serve (one file per UTC day, append mode)
```

Default `$CLAW_CONNECT_HOME` is `~/.config/claw-connect`.

`serve.pid` and `logs/` only appear when the daemon was started by `claude-code:start` (or any future command that daemonizes). Running `claw-connect serve` directly in the foreground creates neither.

---

## `server.toml` minimum viable

```toml
[server]
port = 9900          # public mTLS listener (for remote peers)
host = "0.0.0.0"     # bind address
localPort = 9901     # local proxy (for adapters on this machine)
rateLimit = "100/hour"
streamTimeoutSeconds = 300

[agents.alice]
localEndpoint = "http://127.0.0.1:18800"   # where this agent's adapter listens
rateLimit = "50/hour"
description = "Alice's adapter"
timeoutSeconds = 30

[connectionRequests]
mode = "deny"        # or "accept" / "auto"

[discovery]
providers = ["static"]
cacheTtlSeconds = 300

[validation]
mode = "warn"        # or "enforce"
```

`claw-connect init` generates a file with sensible defaults. Edit as needed; `register`, `friend`, and `remote` commands also write back into their respective files.

---

## Traffic flow

**Local agent A → local agent B (same peer):**
```
adapter for A  →  POST http://127.0.0.1:9901/B/message:send
               →  claw-connect sees B is a local agent
               →  forwards to agents.B.localEndpoint
               →  adapter for B receives the message
```
No TLS. Agents on one peer trust each other implicitly.

**Local agent A → remote peer's agent (via a `[remote]` entry):**
```
adapter for A  →  POST http://127.0.0.1:9901/<remoteHandle>/message:send
               →  claw-connect looks up [remotes.<remoteHandle>]
               →  mTLS out to https://<their-ip>:9900/<remoteTenant>/message:send
                  (presents peer identity.crt; pins remote fingerprint)
               →  their claw-connect validates the peer cert matches a [friend]
               →  forwards to their agents.<remoteTenant>.localEndpoint
```

**Inbound from friend:**
```
their claw-connect  →  https://your-host:9900/<agent>/message:send
                    →  your claw-connect validates friend fingerprint + scope
                    →  forwards to agents.<agent>.localEndpoint
```

---

## Namespace: CLI conventions

New adapter-specific shortcuts use a colon prefix: `claw-connect claude-code:start`. Future adapters follow the same pattern — `cursor:start`, `codex:start`. The colon is just part of the command name; Commander.js handles it as a single token.

Low-level commands (`init`, `register`, `serve`, `friend`, `remote`, `whoami`, `status`, `stop`, `ping`, `directory`) stay un-prefixed and remain the contract. Namespaced commands are convenience compositions; anything they do can also be done by hand.

---

## Running the test suite

```bash
pnpm --filter claw-connect test       # vitest, ~270 tests, ~5s
pnpm --filter claw-connect typecheck
pnpm --filter claw-connect build
```

The test suite spins up real HTTPS servers with ephemeral ports for mTLS scenarios. No external network calls.

---

## Related

- [`a2a-claude-code-adapter`](../a2a-claude-code-adapter) — MCP server that wires Claude Code into claw-connect
- [A2A Protocol v1.0](https://a2a-protocol.org) — the wire protocol this implements

---

## License

MIT. See `LICENSE`.
