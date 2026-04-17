# `tidepool claude-code:start` — Design Spec

**Date:** 2026-04-15
**Status:** Approved for planning

## Problem

Getting two Claude Code sessions talking over tidepool takes eight manual steps today: install two packages, export `TIDEPOOL_HOME`, run `init`, pick a port per agent, `register`, hand-author a `.mcp.json`, open a second terminal to run `tidepool serve`, then finally launch Claude with the development-channels flag. A beginner reading the README gets lost somewhere around step 4.

## Goal

Reduce the happy-path to one command that a beginner can run in a fresh repo and be in Claude Code seconds later, with A2A wired up. Make re-entry instant. Establish a namespace pattern that future adapters (`cursor:start`, `codex:start`, etc.) can slot into.

## Non-goals

- **Not a replacement for the low-level commands.** `init`, `register`, `serve`, `friend`, `remote` all keep their current shape and contract. `claude-code:start` is a convenience that delegates to them.
- **No cross-machine pairing.** This command is for the one-laptop case. Friends and remotes remain manual.
- **No log rotation, log management, or observability beyond a single append-mode file per day.** v1.
- **Not a process manager.** We spawn and track one daemon. We don't supervise restarts, health checks, or crash recovery.

## Command surface

```
tidepool claude-code:start [agent-name]            # default: run claude after setup
tidepool claude-code:start [agent-name] --debug    # foreground serve, user runs claude themselves

tidepool stop                                      # stop the background daemon
tidepool status                                    # extended: includes daemon state
```

The colon-separated command name (`claude-code:start`) establishes the namespace. Commander.js supports it directly. Future siblings: `cursor:start`, `codex:start`.

## Agent name resolution

Order of precedence:

1. **Positional arg** given on the command line. Validated against `/^[a-z][a-z0-9-]*$/`; rejected with a clear error otherwise.
2. **Existing `.mcp.json`** in cwd with an `a2a` entry whose args contain `--agent <name>` — reuse that name. This is the re-entry path.
3. **Generate.** Use `uniqueNamesGenerator({ dictionaries: [animals] })`. Collision-check against existing `[agents.*]` keys in `server.toml`; re-roll up to 5 times; fall back to `<animal>-<hex6>` if exhausted.

## Port assignment

For freshly-registered agents, pick a free loopback port with `net.createServer().listen(0, "127.0.0.1")` and read back `address().port`. Close the probe socket immediately. Re-entry reuses the port from the existing `[agents.<name>].localEndpoint`.

Narrow race: between closing the probe and the adapter binding. If the adapter fails to bind, the adapter reports that error on its own stderr — not our concern to pre-solve.

## Default flow (no `--debug`)

```
1. Resolve configDir                          ($TIDEPOOL_HOME || ~/.config/tidepool)
2. runInit() if identity.crt missing          (idempotent)
3. Resolve agent name                         (rules above)
4. If [agents.<name>] absent in server.toml:
     pickFreeLoopbackPort()
     runRegister(name, localEndpoint)
5. Is daemon running on local port?           (probe GET /.well-known/agent-card.json + PID check)
     no  → spawnServeDaemon()
     yes → no-op
6. ensureMcpJsonEntry({ cwd, agentName })     (creates or merges .mcp.json)
7. Print setup summary + daemon PID/log path
8. If `claude` on PATH:
     exec claude --dangerously-load-development-channels server:a2a
   Else:
     print the launch command with `cd <cwd> && ...` prefix, exit 0
```

## `--debug` flow

```
1-4. Same as default.
5. Print second-terminal instructions:
     In another terminal, run:
       cd <cwd> && claude --dangerously-load-development-channels server:a2a
6. ensureMcpJsonEntry({ cwd, agentName })
7. Spawn `tidepool serve` in the CURRENT process (or inherit-stdio child), streaming output.
   Ctrl+C stops it.

No PID file, no log file, no auto-launch of claude.
```

## Daemon supervision

**Spawn (default mode):**
- `spawn('tidepool', ['serve'], { detached: true, stdio: ['ignore', logFd, logFd] })`
- Write PID to `<configDir>/serve.pid`.
- `.unref()` so the parent can exit.
- Poll `GET http://127.0.0.1:<localPort>/.well-known/agent-card.json` every 100ms for up to 3s. On first 200, declare ready. On timeout, SIGTERM the child, delete partial PID file, error out with pointer to `--debug`.

**Log file:**
- `<configDir>/logs/serve-YYYY-MM-DD.log`, append mode, UTC date.
- One per day. No rotation, no cleanup. User can `rm -rf` any time.

**Running check (`isServeRunning(configDir)`):**
- If PID file absent → false.
- If PID file present but `process.kill(pid, 0)` throws `ESRCH` → stale, delete file, return false.
- If PID alive → probe local port for 200 response. If 200, true. If not, false (daemon is wedged — caller decides whether to kill+respawn or error).

**`tidepool stop`:**
- Read PID file. Missing → "Tidepool is not running." Exit 0.
- Stale (process gone) → delete file, same message.
- Alive → SIGTERM, poll `kill(pid, 0)` every 100ms for up to 2s. If still alive, SIGKILL with warning. Delete PID file. Print "Stopped (was PID …)."

**`tidepool status` (extended):**
- Existing config summary retained.
- Append a "Daemon:" section: running (PID, log path) or not running.

## `.mcp.json` management

`ensureMcpJsonEntry({ cwd, agentName })`:

- Read `<cwd>/.mcp.json` if it exists.
- If parse fails → refuse with the parse error + "Fix or remove `.mcp.json` and rerun."
- If file absent → write `{"mcpServers":{"a2a":{"command":"a2a-claude-code-adapter","args":["--agent",agentName]}}}` with 2-space indent, trailing newline.
- If file present → merge: ensure `mcpServers.a2a` has `command: "a2a-claude-code-adapter"` and `args: ["--agent", agentName]`. Preserve every other key at every level.
- If existing `a2a` entry has a different agent name, overwrite its `args` and log the change to stdout.

## On-disk layout after first run

```
$TIDEPOOL_HOME/
├── identity.crt
├── identity.key
├── server.toml           ← now contains [agents.donkey]
├── friends.toml
├── remotes.toml
├── serve.pid             ← default mode only
└── logs/
    └── serve-2026-04-15.log   ← default mode only
```

Plus in the project directory:
```
<cwd>/.mcp.json           ← created or merged
```

## Error handling — concrete cases

| Case | Behavior |
|---|---|
| `$TIDEPOOL_HOME` unwritable | Fail fast on first write, include `(check permissions on <path>)` in the message. |
| Port 9901 in use by foreign process | Detect via PID-file-mismatch or non-200 probe, abort with instruction to change `localPort` or stop the other service. |
| Port 9901 in use by existing Tidepool daemon | Detected as "our daemon is up," skip spawn. |
| Daemon spawn succeeds but never becomes ready within 3s | SIGTERM child, delete PID file, instruct `--debug` to see output. |
| Stale PID file | Delete and proceed. |
| `claude` not on PATH | Print command with `cd <cwd> && …` prefix, exit 0. Setup still succeeded. |
| `.mcp.json` exists but is invalid JSON | Refuse, tell user to fix or remove. |
| `.mcp.json` exists with `a2a` → different agent | Overwrite args, log the change. |
| Agent name arg fails `^[a-z][a-z0-9-]*$` | Refuse with the regex in the error. |
| Generated name collides 5× | Use `<animal>-<hex6>` fallback. |
| `stop` called with no daemon | Exit 0 with friendly message. |
| `stop` SIGTERM doesn't kill within 2s | SIGKILL with a warning. |

## Testing

**New unit tests** (under `packages/tidepool/test/cli/`):

- `name-resolver.test.ts` — arg wins, `.mcp.json` wins, generated name avoids collisions, fallback on exhaustion.
- `mcp-json.test.ts` — fresh write, merge preserves other mcpServers keys, overwrite on agent name change, refuse on parse error.
- `free-port.test.ts` — returns a valid ephemeral port that can be subsequently bound.
- `serve-daemon.test.ts` — `spawnServeDaemon` creates PID + log files, `isServeRunning` correctly detects up/down/stale, cleanup on readiness timeout.
- `stop.test.ts` — stops a live daemon, handles missing/stale PID, SIGKILL fallback.
- `status.test.ts` (extended) — daemon up vs down reporting.

**New integration test:**

- `claude-code-start-e2e.test.ts` — fresh cwd path creates all expected files and registrations; re-entry path is idempotent (reuses name/port, daemon stays up, no duplicate registrations). `claude` is mocked via `PATH` shim that records its argv to a file; we assert exec happened with the right arguments.

**Existing tests:** unchanged. The 239-test suite must still pass.

## Dependencies

- **New:** `unique-names-generator` (runtime dep of `packages/tidepool`). ~20KB.
- **No change:** node-forge, commander, express, undici, bonjour-service, zod, etc.

## Rollout

- Breaking changes: none. All existing commands keep their shape.
- Follow-up doc changes: update `packages/a2a-claude-code-adapter/README.md` to lead with `tidepool claude-code:start` as the primary path, demoting the manual 6-step flow to an "under the hood" section.

## Risk

Medium. The only genuinely new surface is daemon supervision — detached spawning, PID files, readiness polling. That code is isolated in `cli/serve-daemon.ts` and fully testable. Everything else is a thin orchestration over functions that already exist and are already tested.
