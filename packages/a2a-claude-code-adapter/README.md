# a2a-claude-code-adapter

Make two Claude Code sessions talk to each other.

This package is the glue that lets Claude Code send and receive agent-to-agent ([A2A](https://a2a-protocol.org)) messages. It works alongside [`claw-connect`](../claw-connect), which is the local server that routes those messages.

Messages arriving for your agent show up in Claude Code as a `<channel source="a2a" task_id="...">` block. Claude replies by calling the `a2a_reply` tool, and the reply travels back to the sender.

---

## What you'll have at the end

Two project directories, each with its own Claude Code session. One is "alice", one is "bob". When alice sends an A2A message, bob's Claude sees it and can reply — and vice versa. A single `claw-connect` daemon runs in the background and routes between them; you don't interact with it directly.

```
  Terminal A (in ~/proj-a)      Terminal B (in ~/proj-b)
  ┌────────────────────┐        ┌────────────────────┐
  │ claude             │        │ claude             │
  │   ↓ MCP            │        │   ↓ MCP            │
  │ adapter --agent    │←──────→│ adapter --agent    │
  │   alice            │        │   bob              │
  └────────────────────┘        └────────────────────┘
                │                           │
                └─────────────┬─────────────┘
                              ▼
                  ┌─────────────────────────┐
                  │ claw-connect (daemon)   │
                  │  routes on 127.0.0.1    │
                  │  ~/.config/claw-connect │
                  └─────────────────────────┘
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

Both should print a path. If they don't, the install didn't land.

---

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
5. Starts `claw-connect serve` in the background (PID at `~/.config/claw-connect/serve.pid`, logs in `~/.config/claw-connect/logs/`).
6. Launches Claude Code with the development-channels flag.

Pass a name if you want a specific one:

```bash
claw-connect claude-code:start bob
```

Run the command again in the same project directory — it's idempotent. It reads the existing `.mcp.json`, reuses the name and port, detects the daemon is already up, and drops you straight into Claude Code.

### To start a second session

Open a second terminal, `cd` into a different project, run the same command. You get a different animal name (or supply one) and a second Claude session that shares the single background `claw-connect` daemon. Messages between the two sessions hop through `127.0.0.1` with no TLS.

### Extra commands

| Command | Purpose |
|---|---|
| `claw-connect stop` | Stop the background daemon |
| `claw-connect status` | Show config summary + daemon state (PID, log path) |
| `claw-connect claude-code:start --debug` | Run the server in the foreground and print the `cd <dir> && claude …` command to paste into a second terminal. Use this when the daemon fails to start and you want to see its output live. |

---

## Step 3 — Send a message between the two sessions

In one session, ask Claude to POST an A2A message to the other agent. The port (`9901`) is the daemon's fixed local proxy port; the agent name (`bob`) is whatever you registered:

> Send an A2A message to agent `bob`. POST to `http://127.0.0.1:9901/bob/message:send` with body:
> ```json
> {
>   "message": {
>     "messageId": "hello-1",
>     "role": "user",
>     "parts": [{ "kind": "text", "text": "hello bob" }]
>   }
> }
> ```

In the other terminal you'll see a `<channel source="a2a" task_id="…">` block appear. Claude can reply by calling the `a2a_reply` tool with that task_id, and the reply routes back as the HTTP response to the first session.

That's the round-trip. Everything else is variations on this.

---

## Common problems

**`claw-connect claude-code:start` prints "claude is not on your PATH".** The setup still succeeded — agent is registered, daemon is running, `.mcp.json` is in place. Copy the `cd <dir> && claude …` command it printed and run it in a fresh terminal. Installing Claude Code so `which claude` finds it removes this branch.

**`claw-connect claude-code:start` exits with "Claw Connect did not become ready within 3000ms".** The daemon spawned but its local port never responded. Check the log file at `~/.config/claw-connect/logs/serve-<date>.log` for a crash. The most common causes are port 9900 or 9901 already in use — `lsof -i :9901` tells you who. Either stop that process or edit `~/.config/claw-connect/server.toml` to change `port`/`localPort`, then rerun. `claude-code:start --debug` bypasses the daemon entirely so you can see serve's output live.

**`.mcp.json can't be parsed`.** You have an existing `.mcp.json` in the cwd with broken JSON. Fix the syntax or delete the file and rerun.

**Claude Code starts but doesn't see A2A messages.**
1. Run `claw-connect status` — if it says "Daemon: not running", rerun `claude-code:start` to bring it back.
2. Confirm `.mcp.json` is in the directory you launched `claude` from. Run `pwd` and check.
3. Confirm Claude was launched with `--dangerously-load-development-channels server:a2a`. Without that flag, the MCP channel isn't wired up.

**Second session doesn't receive messages from the first.** Both sessions must be running (check `claw-connect status` shows one daemon). Both project directories must have their own `.mcp.json` pointing at different agents. The URL to POST to is `http://127.0.0.1:9901/<their-agent-name>/message:send` — `9901` is fixed (it's the daemon's local port), the agent name is the other session's name.

**"Agent 'X' is already registered."** Happens if you pass a name that was registered previously in a different cwd, or you manually registered it. Either pick a different name, or reuse the existing home's `.mcp.json` to reattach. `claw-connect whoami` lists all registered agents.

**Want to start fresh.** `claw-connect stop && rm -rf ~/.config/claw-connect`. Also delete the `.mcp.json` in each project. Then start over.

---

## Sending to someone else's machine

`claude-code:start` is for one laptop. For two laptops (or two humans), set it up manually:

1. Each laptop runs its own `claw-connect init` (separate `CLAW_CONNECT_HOME`s are only needed for isolation — a single home works fine too).
2. Each laptop runs `claw-connect whoami` and shares their peer fingerprint out-of-band (Signal, in-person, etc.).
3. Each laptop adds the other as a friend: `claw-connect friend add <their-handle> <their-fingerprint>`.
4. Each laptop adds a `remote` shortcut: `claw-connect remote add <local-handle> https://<their-ip>:9900 <their-agent-name> <their-fingerprint>`.
5. Messages now go over mTLS between the two peers. Everything else is the same.

Cross-machine bootstrap may land as a `claw-connect claude-code:connect` command later.

---

## Flags (adapter)

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

`claude-code:start` is a convenience that composes the low-level commands. Here's the same flow, run by hand:

```bash
export CLAW_CONNECT_HOME="$HOME/.config/claw-connect"
claw-connect init

# Register each agent with its own local port:
claw-connect register alice --local-endpoint http://127.0.0.1:18800
claw-connect register bob   --local-endpoint http://127.0.0.1:18801

# In each project's .mcp.json, point Claude at the adapter:
cat > ~/proj-a/.mcp.json <<'JSON'
{ "mcpServers": { "a2a": { "command": "a2a-claude-code-adapter", "args": ["--agent", "alice"] } } }
JSON

# Start the server (pick one):
claw-connect serve                              # foreground, see output, Ctrl+C to stop
claw-connect claude-code:start --debug          # same, but also auto-generates .mcp.json

# Launch each Claude Code session from its project dir:
cd ~/proj-a && claude --dangerously-load-development-channels server:a2a
```

Every low-level command (`init`, `register`, `serve`, `friend`, `remote`, `whoami`, `status`, `stop`, `ping`) remains available. See the [`claw-connect` README](../claw-connect/README.md) for their reference.

</details>
