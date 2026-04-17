# Web Dashboard Design

**Date:** 2026-04-16
**Task:** 07-web-dashboard
**Status:** Approved

## Summary

A read-only web dashboard served from the Tidepool daemon's existing loopback
HTTP server. Provides at-a-glance visibility into mesh state — peer identity,
agents, friends, active threads, and config — without leaving the browser.
Friend add/remove is the only write operation.

## Decisions

| Question | Decision |
|----------|----------|
| Port | Same as local API (9901), routes under `/dashboard/*` |
| Interactivity | htmx, vendored inline (~14 KB) |
| Live updates | htmx polling every 5s on data sections |
| Templating | HTML as TypeScript template literals — no build step changes |
| Styling | Hand-written dark monospace CSS, terminal aesthetic |
| Pages | Home, Friends, Threads, Config + Audit placeholder |
| Thread data | In-memory `MessageLog` ring buffer in proxy layer |
| Audit page | Placeholder — depends on task 02 |
| Adapter coupling | None — dashboard reads only daemon-owned state |

## Architecture

### Module structure

```
src/dashboard/
  index.ts         — mountDashboard(app, holder, configDir, messageLog) 
  layout.ts        — shared HTML shell (nav, <head>, CSS/htmx refs)
  style.ts         — CSS string constant
  vendor.ts        — htmx minified source as string constant
  message-log.ts   — MessageLog class (in-memory ring buffer)
  pages/
    home.ts        — Home page handler
    friends.ts     — Friends list + add/remove handlers
    threads.ts     — Threads list (read-only)
    config.ts      — Config viewer with reload button
    audit.ts       — Placeholder
```

### Integration point

`mountDashboard()` is called from `createLocalApp()` in `server.ts`. It
registers all `/dashboard/*` routes on the existing Express app. The
`/:tenant/:action` routes remain untouched. The function signature:

```ts
function mountDashboard(
  app: express.Application,
  holder: ConfigHolder,
  configDir: string,
  messageLog: MessageLog,
  startedAt: Date,
): void
```

```
Adapters (claude-code, future ones)
  │
  │  HTTP to 127.0.0.1:9901/:tenant/:action
  │
  ▼
Local Express app (daemon)
  ├── A2A proxy routes          (existing)
  ├── Agent card routes         (existing)
  ├── MessageLog.record()       (new — in proxy handlers)
  └── /dashboard/* routes       (new)
        ├── reads ConfigHolder
        ├── reads MessageLog
        └── calls friends.ts for add/remove
```

### Route table

| Method | Path | Returns | Purpose |
|--------|------|---------|---------|
| GET | `/dashboard` | Full HTML | Home page |
| GET | `/dashboard/friends` | Full HTML | Friends page |
| GET | `/dashboard/friends/table` | HTML fragment | Friends table (polling target) |
| POST | `/dashboard/friends` | HTML fragment | Add friend, return updated table |
| DELETE | `/dashboard/friends/:handle` | HTML fragment | Remove friend, return updated table |
| GET | `/dashboard/threads` | Full HTML | Threads page |
| GET | `/dashboard/threads/table` | HTML fragment | Threads table (polling target) |
| GET | `/dashboard/config` | Full HTML | Config viewer |
| POST | `/dashboard/config/reload` | HTML fragment | Re-read TOML, return updated content |
| GET | `/dashboard/audit` | Full HTML | Placeholder |
| GET | `/dashboard/style.css` | CSS | Stylesheet |
| GET | `/dashboard/htmx.min.js` | JS | Vendored htmx |

### Shared source of truth

The dashboard and CLI share the same data path — no duplication:

```
CLI commands  ──→  friends.ts / config modules  ──→  TOML files
                                                         ↑
Dashboard     ──→  friends.ts / config modules  ──→  TOML files
                                                         ↓
ConfigHolder watches files (500ms poll) ──→ hot-reloads into memory
```

Changes made via CLI appear in the dashboard within 500ms (next poll cycle
plus next htmx poll). Changes made via dashboard are immediately visible to
CLI commands reading the TOML files.

## MessageLog

In-memory ring buffer that records thread metadata as messages flow through
the proxy. Populated in the proxy route handlers in both `createLocalApp()`
and `createPublicApp()`, never in adapter code.

```ts
interface ThreadSummary {
  contextId: string;
  participants: Set<string>;   // agent names
  messageCount: number;
  firstSeen: Date;
  lastActivity: Date;
}
```

- Capacity: 200 threads (oldest evicted when full)
- No message bodies or artifacts stored — metadata only
- Lost on daemon restart (acceptable for MVP)
- Updated by observing the `contextId` field in A2A messages passing through
  the proxy, plus the tenant name and sender agent header

## Pages

### Home

Rendered from `ConfigHolder.server()` + peer identity cert:

- Peer fingerprint (from cert via `getFingerprint()`)
- Public/local port info
- Configured agents table (name, description, endpoint, rate limit)
- Discovery providers list
- Connection request mode
- Daemon uptime (elapsed since `startedAt` timestamp)

### Friends

Rendered from `ConfigHolder.friends()`:

- Table: handle, fingerprint (truncated with click-to-copy), scoped agents
- Add form: handle, fingerprint, optional agents (comma-separated)
  - `hx-post` submits, server returns updated table fragment
- Delete button per row with `hx-confirm` prompt
- Table auto-polls every 5s

### Threads

Rendered from `MessageLog`:

- Table: contextId (truncated), participants, message count, first seen,
  last activity
- Sorted by last activity descending
- Auto-polls every 5s
- Read-only — no actions

### Config

Reads raw TOML files from disk:

- `server.toml`, `friends.toml`, `remotes.toml` displayed in `<pre>` blocks
- Dark-themed monospace rendering
- "Reload" button triggers `ConfigHolder` re-read and refreshes the display

### Audit (placeholder)

- Shows message: "Audit logging is not yet implemented. See task 02."
- Nav link present but visually muted
- Styled consistently with other pages

## Styling

- Background: `#0a0a0a`, text: `#c8c8c8`, monospace font
- Muted teal/green accent for links and active nav
- Tables with subtle row borders, no heavy grids
- Dark-background inputs, light borders
- Fingerprints truncated with click-to-copy (tiny inline JS)
- Status dots: green for running/active, gray for idle
- Total CSS: ~3-4 KB

## htmx patterns

- **Navigation:** `hx-get` + `hx-target="#content"` + `hx-push-url="true"` —
  content swaps with browser history support
- **Polling:** `hx-trigger="every 5s"` on data table containers
- **Friend add:** `hx-post` on form, `hx-target="#friends-table"`,
  `hx-swap="outerHTML"`
- **Friend delete:** `hx-delete` with `hx-confirm`, same target/swap
- **Config reload:** `hx-post` on button, target is the config content area
- **Full-page fallback:** Every page works as a direct URL load (bookmarkable)

htmx source (~14 KB minified) vendored as a string constant in
`src/dashboard/vendor.ts`. Served at `/dashboard/htmx.min.js`. No CDN, no
external network calls.

## Bundle size estimate

- HTML shell + nav: ~2 KB
- CSS: ~3-4 KB
- htmx: ~14 KB
- Page fragments: server-rendered, not shipped as client assets

Total: ~20 KB. Well under the 200 KB cap.

## Startup output

When the daemon starts, the dashboard URL is printed alongside existing ports:

```
Public interface: https://0.0.0.0:9900
Local interface: http://127.0.0.1:9901
Dashboard: http://127.0.0.1:9901/dashboard
```

## Constraints

- Dashboard serves on loopback only (inherited from local server binding)
- No third-party network calls from the dashboard
- No adapter awareness — dashboard reads daemon-owned state only
- No TOML editing beyond friend add/remove
- No message content storage — `MessageLog` is metadata only

## Out of scope

- Audit log viewer (task 02 dependency)
- TOML editing UI (v2)
- Agent creation/management UI (v2)
- Remote administration (v2)
- Authentication token header (documented in spec as optional, deferred)
