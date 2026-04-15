# a2a-claude-code-adapter

MCP **channel** server that exposes inbound [A2A](https://a2a-protocol.org) messages to Claude Code sessions. Pairs with [claw-connect](../claw-connect) for the mTLS / peer plumbing.

Each message a peer sends to your claw-connect arrives in Claude Code as a `<channel source="a2a" task_id="...">` event. Claude calls the `a2a_reply` tool to respond; the reply flows back to the peer.

## Requirements

- Claude Code **v2.1.80+**
- claude.ai login (not API key / Console auth)
- A working claw-connect install with at least one agent configured

## Install

```bash
npm i -g a2a-claude-code-adapter
```

Or, during development from this monorepo:

```bash
pnpm -r build
pnpm link --global --filter a2a-claude-code-adapter
```

## Configure Claude Code

Add to `~/.claude.json` (or a per-project `.mcp.json`):

```json
{
  "mcpServers": {
    "a2a": {
      "command": "a2a-claude-code-adapter",
      "args": ["--agent", "bob"]
    }
  }
}
```

If you have only one agent in `server.toml`, omit `--agent`.

## Start Claude Code

During the channels research preview, launch with:

```bash
claude --dangerously-load-development-channels server:a2a
```

The flag is required only until the adapter is on the approved allowlist.

## Verify end-to-end

In a separate terminal:

```bash
claw-connect serve
```

Then from a peer, send a message. You should see a `<channel source="a2a" task_id="...">` block appear in the Claude Code session. Claude replies via `a2a_reply`; the peer receives the A2A response.

## Two Claude sessions on one host

A single `claw-connect serve` can back any number of Claude sessions. You do not need separate `CLAW_CONNECT_HOME`s or separate `serve` processes.

```bash
# One-time setup in a single home:
claw-connect init
claw-connect register alice --local-endpoint http://127.0.0.1:18800
claw-connect register bob   --local-endpoint http://127.0.0.1:18801
claw-connect serve
```

Then launch two Claude Code sessions, each with its adapter pinned to one agent:

```bash
# Terminal A
claude --dangerously-load-development-channels server:a2a
#   with .mcp.json:  { "mcpServers": { "a2a": { "command": "a2a-claude-code-adapter", "args": ["--agent", "alice"] } } }

# Terminal B
claude --dangerously-load-development-channels server:a2a
#   with .mcp.json:  { "mcpServers": { "a2a": { "command": "a2a-claude-code-adapter", "args": ["--agent", "bob"] } } }
```

Alice can address Bob by `POST`ing to `http://127.0.0.1:<localPort>/bob/message:send` through the adapter's tools (or vice versa); claw-connect dispatches the request directly to Bob's local endpoint with no mTLS hop. The peer identity (at `$CLAW_CONNECT_HOME/identity.crt`) is only involved for traffic leaving the host.

## Flags

| Flag                       | Default                                  |
| -------------------------- | ---------------------------------------- |
| `--agent <name>`           | the sole agent in `server.toml`          |
| `--config-dir <path>`      | `$CLAW_CONNECT_HOME` or `$HOME/.config/claw-connect` |
| `--reply-timeout-ms <n>`   | `600000` (10 min)                        |

## Scope (v1)

- `message:send` only. `message:stream` is future work.
- No permission relay. (A peer cannot approve your Bash calls.)
- HTTP listener binds to `127.0.0.1` only. Trust is delegated to claw-connect's mTLS.
