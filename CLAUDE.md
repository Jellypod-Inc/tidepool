# CLAUDE.md

Guidance for Claude Code and other AI agents working in this repo.

## What this is

**Tidepool** — a peer-to-peer protocol for AI-agent-to-AI-agent communication. Node.js/TypeScript daemon + CLI (`@jellypod/tidepool`) and a Claude Code MCP adapter (`@jellypod/tidepool-claude-code`). pnpm workspace.

The package was previously named `clawconnect` / `a2a`; the rename to Tidepool is decided but not fully propagated through code. Don't treat lingering `clawconnect`/`a2a` identifiers as bugs unless asked.

## Architecture source of truth

**`docs/architecture.md` is the architecture source of truth.** Read it before making structural changes.

**You must update `docs/architecture.md` in the same change when you:**

- Add, remove, rename, or move a module in `src/` or `adapters/*/src/`
- Change a port, binding, or plane (local loopback vs public mTLS)
- Add or remove an HTTP endpoint, A2A extension, or A2A method
- Change the request middleware pipeline or trust/rate-limit order
- Change the file layout under `$TIDEPOOL_HOME`
- Complete or abandon a roadmap task in `tasks/` (update §8 of the doc)

Internal refactors that don't cross module boundaries don't need a doc update.

## Design principles (do not violate without discussion)

These are load-bearing. See `README.md` → Design principles and `docs/architecture.md` §1.

1. **Prose is the only interface between agents.** No typed RPC, no cross-peer tool calls. Agents coordinate in natural language.
2. **Locality is opaque to agents.** Adapters receive peer *handles*; only the daemon knows whether a handle is local or remote. Never leak local-vs-remote through the adapter surface.
3. **Trust is explicit.** Friendship is a mutual, deliberate decision. No implicit trust from discovery.
4. **Local-first.** Nothing leaves the peer except user-authorized messages.

## Layout

| Path | What |
|------|------|
| `src/` | Daemon source (TypeScript, ESM, Node ≥20) |
| `src/bin/cli.ts` | CLI entry (commander) |
| `src/cli/` | Subcommand implementations |
| `src/session/` | Adapter session registry (SSE-based, liveness-only) |
| `src/discovery/` | Static, mDNS, directory providers + registry |
| `src/dashboard/` | Local web dashboard (mounted on local plane) |
| `adapters/claude-code/` | MCP adapter package (separate workspace) |
| `test/` | Vitest tests — mirror of `src/` plus `e2e-*.ts` |
| `tasks/` | Design specs for roadmap items |
| `fixtures/` | Canonical example configs |
| `docs/architecture.md` | Architecture source of truth |
| `THREATS.md` | Threat model |

## Commands

```bash
pnpm install
pnpm build         # tsc + fix shebang + build adapters
pnpm dev           # tsx watch src/server.ts
pnpm test          # daemon tests only
pnpm test:all      # daemon + adapter tests
pnpm typecheck     # tsc --noEmit across workspace
pnpm smoke         # scripts/smoke.ts — local two-peer smoke test
```

## Conventions

- TypeScript strict mode, ESM.
- Zod for all wire validation (`src/schemas.ts`, `src/wire-validation.ts`).
- TOML for persistent config. Never introduce a new format.
- No hidden global state — persistent state flows through `config-holder.ts`.
- Tests live beside their module in `test/` with the same filename.
- `e2e-*.test.ts` are multi-daemon integration tests; they spin up real servers on ephemeral ports.

## Doing work here

- Read `docs/architecture.md` first for structural changes.
- Keep the prose-only-between-agents and opaque-locality invariants.
- When adding a new CLI command, follow the pattern in `src/cli/*.ts` and wire it in `src/bin/cli.ts`.
- When adding a new HTTP endpoint, add it to the protocol surface table in `docs/architecture.md` §6.
- When changing the middleware pipeline, update the sequence diagram in §4.

## Not in scope without asking

- Renaming the package or module identifiers en masse (rename is deliberately deferred).
- Introducing a cloud dependency, central server, or account system.
- Adding typed RPC surface between agents.
- Adding a second persistent-config format.
