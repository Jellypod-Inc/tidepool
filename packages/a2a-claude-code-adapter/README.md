# a2a-claude-code-adapter

Make two Claude Code sessions talk to each other.

This package is the glue that lets Claude Code send and receive agent-to-agent ([A2A](https://a2a-protocol.org)) messages. It works alongside [`claw-connect`](../claw-connect), which is the local server that routes those messages.

Messages arriving for your agent show up in Claude Code as a `<channel source="a2a" task_id="...">` block. Claude replies by calling the `a2a_reply` tool, and the reply travels back to the sender.

---

## What you'll have at the end

Two terminals open on the same laptop, each running its own Claude Code session. One is "alice", one is "bob". When alice sends an A2A message, bob's Claude sees it and can reply — and vice versa. Both sessions share a single `claw-connect` process running in a third terminal.

```
  Terminal A                  Terminal B                  Terminal C
  ┌────────────┐              ┌────────────┐              ┌──────────────────┐
  │ claude     │              │ claude     │              │ claw-connect     │
  │  ↓ MCP     │              │  ↓ MCP     │              │   serve          │
  │ adapter    │←──messages──→│ adapter    │  ←────→      │                  │
  │  --agent   │              │  --agent   │              │  routes between  │
  │   alice    │              │   bob      │              │  alice and bob   │
  └────────────┘              └────────────┘              └──────────────────┘
```

---

## Before you start

You'll need:

1. **Claude Code v2.1.80 or newer.** Check with `claude --version`.
2. **A `claude.ai` login**, not an API key. In Claude Code, run `/login` and choose the claude.ai option if you haven't.
3. **Node 20 or newer** and **pnpm**. Check with `node --version` and `pnpm --version`.

---

## Step 1 — Install the tools

If you're just using the published packages:

```bash
npm i -g claw-connect a2a-claude-code-adapter
```

If you're developing from this monorepo:

```bash
cd /path/to/clawconnect      # the repo root
pnpm install
pnpm -r build
pnpm link --global --filter claw-connect
pnpm link --global --filter a2a-claude-code-adapter
```

Verify both commands are on your PATH:

```bash
which claw-connect
which a2a-claude-code-adapter
```

## Step 2 — Start a Claude Code session wired up for A2A

From any project directory:

```bash
claw-connect claude-code:start
```

What this does, in order:

1. Sets up a Claw Connect "home" at `~/.config/claw-connect` (first run only).
2. Generates a friendly name for this agent (e.g. `donkey`) if you don't provide one.
3. Picks a free local port and registers the agent.
4. Writes or merges `.mcp.json` in the current directory so Claude Code loads the adapter.
5. Starts `claw-connect serve` in the background (PID and logs under `~/.config/claw-connect`).
6. Launches Claude Code with the development-channels flag.

Pass a name if you want a specific one:

```bash
claw-connect claude-code:start bob
```

Run it again in the same project directory — it's idempotent. The command reads the existing `.mcp.json`, reuses the name and port, and drops you straight into Claude Code.

### To start a second session

Open a second terminal, `cd` into a different project, and run the same command. You'll get a different animal name (or supply one) and a second session talking through the same background `claw-connect serve`. Messages between the two sessions hop through `127.0.0.1` with no TLS.

### Extra commands

| Command | Purpose |
|---|---|
| `claw-connect stop` | Stop the background server |
| `claw-connect status` | See if the server is running and where logs are |
| `claw-connect claude-code:start --debug` | Run the server in the foreground and print the `cd <dir> && claude …` command to paste into a second terminal (useful for debugging startup issues) |

## Step 3 — Send a message between the two sessions

In one session, ask Claude to POST an A2A message to the other agent:

> Send an A2A message to agent `bob` (POST to `http://127.0.0.1:9901/bob/message:send`) with body:
> ```json
> {
>   "message": {
>     "messageId": "hello-1",
>     "role": "user",
>     "parts": [{ "kind": "text", "text": "hello bob" }]
>   }
> }
> ```

In the other terminal you'll see a `<channel source="a2a" task_id="...">` block appear. Claude can reply with the `a2a_reply` tool, and the reply routes back as the HTTP response to the first session.

That's the round-trip. Everything else is variations on this.

---

## Common problems

**`which claw-connect` prints nothing.** Step 1 didn't finish. Re-run `pnpm -r build && pnpm link --global --filter claw-connect` from the repo root, or install with `npm i -g claw-connect`.

**`claw-connect init` says "no such file" or fails.** `$CLAW_CONNECT_HOME` probably isn't set in the shell you're running. Run `echo $CLAW_CONNECT_HOME` to check. Every terminal you open needs the export re-done unless you put it in your shell's rc file.

**`claw-connect register` says "Peer identity not found … Run 'claw-connect init' first."** You're pointing at a home that hasn't been initialized. Run `claw-connect init` in the same shell (same `CLAW_CONNECT_HOME`).

**Claude Code doesn't show A2A messages.** Three things to check:
1. Did you start `claude` from the project directory that contains `.mcp.json`? Run `pwd` and re-check.
2. Is `claw-connect serve` still running in Terminal C? If it exited, the routing is broken.
3. Did you pass `--dangerously-load-development-channels server:a2a`? Without it, the adapter won't be wired up.

**Port already in use.** Something else is on 9900/9901/18800/18801. Edit `$CLAW_CONNECT_HOME/server.toml` to change `port` / `localPort`, or re-register the agents with different `--local-endpoint` ports. Restart `claw-connect serve` afterwards.

---

## Sending to someone else's machine

Everything above is for two sessions on one laptop. For two different laptops (or two humans), the setup is:

1. Each laptop runs its own `claw-connect init` and picks its own `CLAW_CONNECT_HOME`.
2. Each laptop runs `claw-connect whoami` and shares their peer fingerprint out-of-band (Signal, in-person, etc.).
3. Each laptop adds the other as a friend: `claw-connect friend add <their-handle> <their-fingerprint>`.
4. Each laptop adds a `remote` shortcut pointing at the other's address: `claw-connect remote add <local-handle> https://<their-ip>:9900 <their-agent-name> <their-fingerprint>`.
5. Messages now go over mTLS between the two peers. The rest of the flow is the same.

---

## Flags

| Flag                       | Default                                              |
| -------------------------- | ---------------------------------------------------- |
| `--agent <name>`           | the sole agent in `server.toml`                      |
| `--config-dir <path>`      | `$CLAW_CONNECT_HOME` or `$HOME/.config/claw-connect` |
| `--reply-timeout-ms <n>`   | `600000` (10 minutes)                                |

---

## What v1 does and doesn't do

- Supports `message:send`. Streaming (`message:stream`) is future work.
- No permission relay — another agent can't approve a Bash call on your behalf.
- The adapter's HTTP listener binds to `127.0.0.1` only. Trust for cross-machine traffic is delegated to claw-connect's mTLS.

---

<details>
<summary>Manual setup (under the hood)</summary>

`claude-code:start` is just a convenience. Here's what it does step by step — the same flow you'd run manually.

```bash
export CLAW_CONNECT_HOME="$HOME/.config/claw-connect"
claw-connect init

# Register each agent with its own local port:
claw-connect register alice --local-endpoint http://127.0.0.1:18800
claw-connect register bob   --local-endpoint http://127.0.0.1:18801

# In each project's .mcp.json, point Claude at the adapter:
cat > ~/claude-alice/.mcp.json <<'JSON'
{ "mcpServers": { "a2a": { "command": "a2a-claude-code-adapter", "args": ["--agent", "alice"] } } }
JSON

# Start the server in a dedicated terminal:
claw-connect serve

# Launch each Claude Code session from its project dir:
claude --dangerously-load-development-channels server:a2a
```

The low-level commands (`init`, `register`, `serve`, `friend`, `remote`, `whoami`, `status`, `stop`) all remain available and do exactly what they say.

</details>
