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

Both should print a path. If they don't, fix that before moving on.

---

## Step 2 — Create one home, two agents

A "home" is a config directory that holds one machine's identity and the list of agents that run on it. **You only need one home for two local Claude sessions.**

Pick any directory you like. A good default is `~/.config/claw-connect`:

```bash
export CLAW_CONNECT_HOME="$HOME/.config/claw-connect"
claw-connect init
```

You should see `Initialized …` printed. Behind the scenes this creates:

```
~/.config/claw-connect/
├── identity.crt       ← your machine's public certificate (fingerprint goes in here)
├── identity.key       ← matching private key (do not share)
├── server.toml        ← settings + list of agents
├── friends.toml       ← people your machine trusts (empty for now)
└── remotes.toml       ← shortcuts to other machines (empty for now)
```

Now register two agents. An "agent" is a name plus a local port where its Claude session will listen:

```bash
claw-connect register alice --local-endpoint http://127.0.0.1:18800
claw-connect register bob   --local-endpoint http://127.0.0.1:18801
```

You can check it worked:

```bash
claw-connect whoami
```

Expected output:

```
peer fingerprint: sha256:abc123…
agents: alice, bob
```

The fingerprint is your machine's unique ID. You'd share it with a friend if you wanted them to connect to you from another laptop — but for two local sessions, you can ignore it.

---

## Step 3 — Tell each Claude Code session which agent it is

Each Claude session needs its own MCP config file so it loads the adapter as one specific agent. We'll set up two project directories, one per session.

Make a directory for alice's session and put a `.mcp.json` in it:

```bash
mkdir -p ~/claude-alice
cat > ~/claude-alice/.mcp.json <<'JSON'
{
  "mcpServers": {
    "a2a": {
      "command": "a2a-claude-code-adapter",
      "args": ["--agent", "alice"]
    }
  }
}
JSON
```

And a separate one for bob:

```bash
mkdir -p ~/claude-bob
cat > ~/claude-bob/.mcp.json <<'JSON'
{
  "mcpServers": {
    "a2a": {
      "command": "a2a-claude-code-adapter",
      "args": ["--agent", "bob"]
    }
  }
}
JSON
```

The only difference between the two files is the agent name.

---

## Step 4 — Start claw-connect

Open a new terminal (Terminal C in the picture above) and run:

```bash
export CLAW_CONNECT_HOME="$HOME/.config/claw-connect"   # same home as Step 2
claw-connect serve
```

You should see:

```
Public interface: https://0.0.0.0:9900
Local interface: http://127.0.0.1:9901
```

Leave this running. Every A2A message hops through this server.

---

## Step 5 — Start the two Claude Code sessions

**Terminal A (alice):**

```bash
cd ~/claude-alice
claude --dangerously-load-development-channels server:a2a
```

**Terminal B (bob):**

```bash
cd ~/claude-bob
claude --dangerously-load-development-channels server:a2a
```

> **About that flag.** `--dangerously-load-development-channels` is required today because the adapter isn't on Claude Code's approved allowlist yet. The "channel" is just the pipe that carries A2A messages into the session. The flag will go away once the adapter is officially blessed.

---

## Step 6 — Make alice talk to bob

In **alice's** Claude session, ask her to send a message:

> Send an A2A message to the `bob` agent saying "hello bob". You can do it by POSTing to `http://127.0.0.1:9901/bob/message:send` with a body like:
> ```json
> {
>   "message": {
>     "messageId": "hello-1",
>     "role": "user",
>     "parts": [{ "kind": "text", "text": "hello bob" }]
>   }
> }
> ```

Alice will make that HTTP call. Claw-connect will route it straight to bob's adapter, which delivers it into bob's Claude session.

In **bob's** session, you'll see something like:

```
<channel source="a2a" task_id="…">
role: user
hello bob
</channel>
```

Bob's Claude can then reply:

> Please call the `a2a_reply` tool with task_id "…" and text "hi alice, got it".

The reply travels back through claw-connect to alice's session, and her original HTTP call returns it as the response.

That's the round-trip. Anything else is variations on this.

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
