# Web dashboard

## Context

The only ways to operate Tidepool today are the CLI and looking at TOML
files. Both competitors have better surfaces:

- **Langchain-Chatchat** ships a Streamlit UI with pages for dialogue,
  knowledge base, MCP management, and model configuration
- **ClawNet** exposes a REST API at `localhost:3998`

Onboarding and day-to-day operations in Tidepool currently require editing
TOML, running CLI commands, and reading log files. A browser dashboard would
make setup demoable to someone who does not live in a terminal, and would
make live mesh state visible at a glance.

## Proposed approach

Serve a small web app from the daemon on a new loopback port (e.g., `:9902`).

### MVP scope (read-only + friend management)

- **Home** — this peer's fingerprint, handle, configured agents, discovery
  providers, uptime
- **Friends** — table of friends with fingerprint, scope, last-seen, rate-limit
  state; add / remove friend from the UI
- **Threads** — list of active `context_id`s with participants, last activity,
  message count; click to view thread history (read-only)
- **Audit** — tail of the audit log with event-type filter (depends on task 02)
- **Config** — view `server.toml` / `friends.toml` / `remotes.toml` as
  read-only syntax-highlighted text, with a "reload" button

### Out of scope (v2)

- Editing TOML through the UI (beyond friend add/remove)
- Agent creation or management UI
- Any remote administration — the dashboard is strictly local

### Stack

- Backend: new routes on the existing loopback HTTP server; no separate port
  if feasible
- Frontend: plain HTML + htmx, or a small React single-page app. Pick whatever
  keeps the dependency footprint small. No framework heavier than React.
- Auth: loopback-only bind. Optional shared-secret token header (configurable
  under `[dashboard]` in `server.toml`) for users who want extra protection.

## Acceptance criteria

- Dashboard serves on loopback only; binding to non-loopback is refused
- Pages listed in MVP scope render with live data
- Adding a friend through the UI writes to `friends.toml` and takes effect
  via hot-reload
- Removing a friend removes their entry and the change is audit-logged
  (task 02)
- Bundle size: under 200 KB uncompressed for the client
- No network calls to any third-party service from the dashboard

## Effort

Medium — 1 to 2 weeks for MVP.

## Open questions / risks

- **Scope sprawl**: it's tempting to turn this into a full admin surface.
  Hard-cap the MVP to the pages listed above.
- **Framework choice**: htmx keeps it boring and server-rendered; React makes
  a thread viewer easier. Default to htmx unless there's a specific need.
- **Auth against malicious local processes**: loopback-only binding is not a
  security boundary against other processes on the same machine. The token
  header is the real defense. Document the threat model.
- **Dashboard-adapter-daemon split**: the dashboard should talk to the daemon,
  not to adapters. Keep the boundary clean.

## File pointers

- `packages/tidepool/src/server.ts` — loopback HTTP server
- `packages/tidepool/src/types.ts` — config types
- New: `packages/tidepool-dashboard/` — if the dashboard gets its own
  package; otherwise served from `packages/tidepool/`
