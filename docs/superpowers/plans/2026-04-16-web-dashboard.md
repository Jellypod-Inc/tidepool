# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an htmx web dashboard to the Tidepool daemon, served from the existing loopback HTTP server at `/dashboard/*`, providing read-only visibility into mesh state plus friend add/remove.

**Architecture:** New `src/dashboard/` module mounted onto the existing local Express app via `mountDashboard()`. HTML generated as TypeScript template literals, CSS as a string constant, htmx vendored inline. A new `MessageLog` class in the proxy layer records thread metadata (no message content) for the threads page.

**Tech Stack:** Express 5, htmx (vendored ~14 KB), hand-written CSS, TypeScript template literals

**Spec:** `docs/superpowers/specs/2026-04-16-web-dashboard-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/dashboard/message-log.ts` | Create | In-memory ring buffer for thread metadata |
| `src/dashboard/style.ts` | Create | CSS string constant |
| `src/dashboard/vendor.ts` | Create | htmx minified source as string constant |
| `src/dashboard/layout.ts` | Create | Shared HTML shell — head, nav, content wrapper |
| `src/dashboard/pages/home.ts` | Create | Home page handler |
| `src/dashboard/pages/friends.ts` | Create | Friends page + add/remove handlers |
| `src/dashboard/pages/threads.ts` | Create | Threads page (read-only) |
| `src/dashboard/pages/config.ts` | Create | Config viewer + reload handler |
| `src/dashboard/pages/audit.ts` | Create | Audit placeholder page |
| `src/dashboard/index.ts` | Create | `mountDashboard()` — registers all routes |
| `src/server.ts` | Modify | Create MessageLog, pass to createLocalApp/createPublicApp, call mountDashboard, print dashboard URL |
| `test/dashboard/message-log.test.ts` | Create | MessageLog unit tests |
| `test/dashboard/pages/friends.test.ts` | Create | Friends page handler tests |
| `test/dashboard/dashboard-e2e.test.ts` | Create | E2E test — mount dashboard, hit routes, verify HTML |

---

### Task 1: MessageLog — in-memory ring buffer

**Files:**
- Create: `src/dashboard/message-log.ts`
- Test: `test/dashboard/message-log.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard/message-log.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MessageLog } from "../../src/dashboard/message-log.js";

describe("MessageLog", () => {
  it("records a new thread on first message", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads).toHaveLength(1);
    expect(threads[0].contextId).toBe("ctx-1");
    expect(threads[0].participants).toEqual(["alice"]);
    expect(threads[0].messageCount).toBe(1);
  });

  it("accumulates participants and message count", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-1", agent: "bob" });
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads).toHaveLength(1);
    expect(threads[0].participants).toEqual(["alice", "bob"]);
    expect(threads[0].messageCount).toBe(3);
  });

  it("tracks multiple threads independently", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });

    const threads = log.list();
    expect(threads).toHaveLength(2);
  });

  it("evicts oldest thread when capacity is exceeded", () => {
    const log = new MessageLog(2);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });
    log.record({ contextId: "ctx-3", agent: "carol" });

    const threads = log.list();
    expect(threads).toHaveLength(2);
    const ids = threads.map((t) => t.contextId);
    expect(ids).not.toContain("ctx-1");
    expect(ids).toContain("ctx-2");
    expect(ids).toContain("ctx-3");
  });

  it("returns threads sorted by lastActivity descending", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });
    // Touch ctx-1 again so it's most recent
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads[0].contextId).toBe("ctx-1");
    expect(threads[1].contextId).toBe("ctx-2");
  });

  it("skips messages with no contextId", () => {
    const log = new MessageLog(100);
    log.record({ contextId: undefined, agent: "alice" });

    expect(log.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dashboard/message-log.test.ts`
Expected: FAIL — cannot resolve `../../src/dashboard/message-log.js`

- [ ] **Step 3: Implement MessageLog**

Create `src/dashboard/message-log.ts`:

```ts
export interface ThreadSummary {
  contextId: string;
  participants: string[];
  messageCount: number;
  firstSeen: Date;
  lastActivity: Date;
}

interface ThreadEntry {
  contextId: string;
  participants: Set<string>;
  messageCount: number;
  firstSeen: Date;
  lastActivity: Date;
}

export interface RecordOpts {
  contextId: string | undefined;
  agent: string;
}

export class MessageLog {
  private threads = new Map<string, ThreadEntry>();
  private insertionOrder: string[] = [];

  constructor(private capacity: number) {}

  record(opts: RecordOpts): void {
    if (!opts.contextId) return;

    const existing = this.threads.get(opts.contextId);
    if (existing) {
      existing.participants.add(opts.agent);
      existing.messageCount++;
      existing.lastActivity = new Date();
      return;
    }

    // Evict oldest if at capacity
    if (this.threads.size >= this.capacity) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.threads.delete(oldest);
    }

    this.threads.set(opts.contextId, {
      contextId: opts.contextId,
      participants: new Set([opts.agent]),
      messageCount: 1,
      firstSeen: new Date(),
      lastActivity: new Date(),
    });
    this.insertionOrder.push(opts.contextId);
  }

  list(): ThreadSummary[] {
    return Array.from(this.threads.values())
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
      .map((entry) => ({
        contextId: entry.contextId,
        participants: Array.from(entry.participants),
        messageCount: entry.messageCount,
        firstSeen: entry.firstSeen,
        lastActivity: entry.lastActivity,
      }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/dashboard/message-log.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/message-log.ts test/dashboard/message-log.test.ts
git commit -m "feat(dashboard): add MessageLog in-memory ring buffer for thread metadata"
```

---

### Task 2: CSS and vendor assets

**Files:**
- Create: `src/dashboard/style.ts`
- Create: `src/dashboard/vendor.ts`

- [ ] **Step 1: Create the CSS constant**

Create `src/dashboard/style.ts`:

```ts
export const DASHBOARD_CSS = `
:root {
  --bg: #0a0a0a;
  --bg-raised: #141414;
  --bg-input: #1a1a1a;
  --border: #2a2a2a;
  --text: #c8c8c8;
  --text-muted: #787878;
  --accent: #5b9a8b;
  --accent-hover: #7bc4b2;
  --danger: #c75050;
  --danger-hover: #e06060;
  --success: #5b9a5b;
  --font: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
  display: flex;
  min-height: 100vh;
}

nav {
  width: 200px;
  background: var(--bg-raised);
  border-right: 1px solid var(--border);
  padding: 20px 0;
  flex-shrink: 0;
}

nav .brand {
  padding: 0 16px 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
  font-size: 16px;
  color: var(--accent);
  font-weight: bold;
}

nav a {
  display: block;
  padding: 8px 16px;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
}

nav a:hover { color: var(--text); background: var(--bg); }
nav a.active { color: var(--accent); background: var(--bg); }
nav a.muted { opacity: 0.4; }

main {
  flex: 1;
  padding: 24px 32px;
  max-width: 960px;
  overflow-x: auto;
}

h1 { font-size: 20px; margin-bottom: 16px; color: var(--text); font-weight: 600; }
h2 { font-size: 16px; margin: 24px 0 12px; color: var(--text); font-weight: 600; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid var(--border);
  color: var(--text-muted);
  font-weight: 500;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.fingerprint {
  cursor: pointer;
  border-bottom: 1px dashed var(--text-muted);
}
.fingerprint:hover { color: var(--accent); }
.fingerprint::after { content: " \u2398"; font-size: 11px; color: var(--text-muted); }

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.green { background: var(--success); }
.status-dot.gray { background: var(--text-muted); }

pre {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 12px 0;
}

form {
  display: flex;
  gap: 8px;
  align-items: end;
  margin: 16px 0;
  flex-wrap: wrap;
}

label {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

input[type="text"] {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
}
input[type="text"]:focus {
  outline: none;
  border-color: var(--accent);
}

button, .btn {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 14px;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.danger { color: var(--danger); }
button.danger:hover { border-color: var(--danger-hover); color: var(--danger-hover); }
button.primary { border-color: var(--accent); color: var(--accent); }
button.primary:hover { background: var(--accent); color: var(--bg); }

.info-grid {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 4px 16px;
  margin: 12px 0;
}
.info-grid dt { color: var(--text-muted); }
.info-grid dd { color: var(--text); }

.placeholder {
  color: var(--text-muted);
  padding: 48px 0;
  text-align: center;
  font-style: italic;
}

.toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--bg-raised);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 8px 16px;
  color: var(--accent);
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.3s;
}
.toast.show { opacity: 1; }
`;
```

- [ ] **Step 2: Create the htmx vendor constant**

Create `src/dashboard/vendor.ts`. This file holds the htmx 2.0 minified source as a string. The actual content is ~14 KB — fetch it at implementation time:

```ts
// htmx 2.0.4 minified — vendored to avoid CDN dependency.
// Source: https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js
// Update by replacing this string with the latest minified build.
export const HTMX_JS = `/* paste htmx.min.js contents here during implementation */`;
```

The implementer must download htmx 2.0.x minified and paste it into this constant. Run:
```bash
curl -sL https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js > /tmp/htmx.min.js
wc -c /tmp/htmx.min.js  # should be ~47 KB unminified or ~14 KB gzipped
```

Then assign the file contents to `HTMX_JS`.

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors related to dashboard files

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/style.ts src/dashboard/vendor.ts
git commit -m "feat(dashboard): add CSS and vendored htmx assets"
```

---

### Task 3: Layout — shared HTML shell

**Files:**
- Create: `src/dashboard/layout.ts`

- [ ] **Step 1: Create the layout module**

Create `src/dashboard/layout.ts`:

```ts
export interface LayoutOpts {
  title: string;
  activePage: "home" | "friends" | "threads" | "config" | "audit";
  content: string;
}

const NAV_ITEMS: { page: LayoutOpts["activePage"]; label: string; href: string; muted?: boolean }[] = [
  { page: "home", label: "Home", href: "/dashboard" },
  { page: "friends", label: "Friends", href: "/dashboard/friends" },
  { page: "threads", label: "Threads", href: "/dashboard/threads" },
  { page: "config", label: "Config", href: "/dashboard/config" },
  { page: "audit", label: "Audit", href: "/dashboard/audit", muted: true },
];

export function renderLayout(opts: LayoutOpts): string {
  const nav = NAV_ITEMS.map((item) => {
    const classes = [
      item.page === opts.activePage ? "active" : "",
      item.muted ? "muted" : "",
    ].filter(Boolean).join(" ");
    return `<a href="${item.href}" hx-get="${item.href}" hx-target="#content" hx-push-url="true" class="${classes}">${item.label}</a>`;
  }).join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} — Tidepool</title>
  <link rel="stylesheet" href="/dashboard/style.css">
  <script src="/dashboard/htmx.min.js"></script>
</head>
<body>
  <nav>
    <div class="brand">tidepool</div>
    ${nav}
  </nav>
  <main id="content">
    ${opts.content}
  </main>
  <script>
    document.addEventListener("click", function(e) {
      if (!e.target.classList.contains("fingerprint")) return;
      var full = e.target.getAttribute("data-full");
      if (!full) return;
      navigator.clipboard.writeText(full).then(function() {
        var toast = document.getElementById("toast");
        if (!toast) return;
        toast.textContent = "Copied: " + full.slice(0, 20) + "…";
        toast.classList.add("show");
        setTimeout(function() { toast.classList.remove("show"); }, 2000);
      });
    });
  </script>
  <div id="toast" class="toast"></div>
</body>
</html>`;
}

export function renderContent(content: string): string {
  return content;
}
```

`renderLayout()` returns a full HTML page (for direct URL loads). `renderContent()` returns just the inner content (for htmx fragment swaps — used when the request has the `HX-Request` header).

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/layout.ts
git commit -m "feat(dashboard): add shared HTML layout shell with nav"
```

---

### Task 4: Home page

**Files:**
- Create: `src/dashboard/pages/home.ts`

- [ ] **Step 1: Create the home page module**

Create `src/dashboard/pages/home.ts`:

```ts
import type { ConfigHolder } from "../../config-holder.js";
import { readPeerFingerprint } from "../../identity-paths.js";

export interface HomeContext {
  holder: ConfigHolder;
  configDir: string;
  startedAt: Date;
}

function truncateFingerprint(fp: string): string {
  // "sha256:abcdef..." → "sha256:abcdef01…"
  const prefix = fp.slice(0, 15);
  return `${prefix}…`;
}

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function renderHomePage(ctx: HomeContext): string {
  const config = ctx.holder.server();
  const fingerprint = readPeerFingerprint(ctx.configDir);
  const agents = Object.entries(config.agents);

  const agentRows = agents.length === 0
    ? `<tr><td colspan="4" class="placeholder">No agents registered</td></tr>`
    : agents.map(([name, agent]) => `
        <tr>
          <td>${name}</td>
          <td>${agent.description || "—"}</td>
          <td>${agent.localEndpoint}</td>
          <td>${agent.rateLimit}</td>
        </tr>`).join("");

  return `
    <h1>Home</h1>
    <dl class="info-grid">
      <dt>Fingerprint</dt>
      <dd><span class="fingerprint" data-full="${fingerprint}">${truncateFingerprint(fingerprint)}</span></dd>
      <dt>Public</dt>
      <dd>https://${config.server.host}:${config.server.port}</dd>
      <dt>Local</dt>
      <dd>http://127.0.0.1:${config.server.localPort}</dd>
      <dt>Uptime</dt>
      <dd>${formatUptime(ctx.startedAt)}</dd>
      <dt>Connection requests</dt>
      <dd>${config.connectionRequests.mode}</dd>
      <dt>Discovery</dt>
      <dd>${config.discovery.providers.join(", ")}</dd>
    </dl>

    <h2>Agents</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Description</th><th>Endpoint</th><th>Rate limit</th></tr>
      </thead>
      <tbody>
        ${agentRows}
      </tbody>
    </table>
  `;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/pages/home.ts
git commit -m "feat(dashboard): add home page showing peer identity and agents"
```

---

### Task 5: Friends page with add/remove

**Files:**
- Create: `src/dashboard/pages/friends.ts`
- Test: `test/dashboard/pages/friends.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard/pages/friends.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderFriendsTable } from "../../../src/dashboard/pages/friends.js";
import type { FriendsConfig } from "../../../src/types.js";

describe("renderFriendsTable", () => {
  it("renders an empty state when no friends", () => {
    const config: FriendsConfig = { friends: {} };
    const html = renderFriendsTable(config);
    expect(html).toContain("No friends");
  });

  it("renders a row per friend", () => {
    const config: FriendsConfig = {
      friends: {
        alice: { fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        bob: { fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agents: ["code-review"] },
      },
    };
    const html = renderFriendsTable(config);
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("code-review");
  });

  it("shows 'all agents' when no scope restriction", () => {
    const config: FriendsConfig = {
      friends: {
        alice: { fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
    };
    const html = renderFriendsTable(config);
    expect(html).toContain("all agents");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dashboard/pages/friends.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement the friends page**

Create `src/dashboard/pages/friends.ts`:

```ts
import type express from "express";
import type { ConfigHolder } from "../../config-holder.js";
import { addFriend, removeFriend, writeFriendsConfig } from "../../friends.js";
import type { FriendsConfig } from "../../types.js";

function truncateFingerprint(fp: string): string {
  return `${fp.slice(0, 15)}…`;
}

export function renderFriendsTable(friends: FriendsConfig): string {
  const entries = Object.entries(friends.friends);

  if (entries.length === 0) {
    return `<div id="friends-table"><p class="placeholder">No friends yet</p></div>`;
  }

  const rows = entries.map(([handle, entry]) => {
    const scope = entry.agents ? entry.agents.join(", ") : "all agents";
    return `
      <tr>
        <td>${handle}</td>
        <td><span class="fingerprint" data-full="${entry.fingerprint}">${truncateFingerprint(entry.fingerprint)}</span></td>
        <td>${scope}</td>
        <td>
          <button class="danger"
            hx-delete="/dashboard/friends/${encodeURIComponent(handle)}"
            hx-target="#friends-table"
            hx-swap="outerHTML"
            hx-confirm="Remove friend ${handle}?">Remove</button>
        </td>
      </tr>`;
  }).join("");

  return `
    <div id="friends-table" hx-get="/dashboard/friends/table" hx-trigger="every 5s" hx-swap="outerHTML">
      <table>
        <thead>
          <tr><th>Handle</th><th>Fingerprint</th><th>Scope</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderFriendsPage(holder: ConfigHolder): string {
  const friends = holder.friends();
  return `
    <h1>Friends</h1>
    <form hx-post="/dashboard/friends" hx-target="#friends-table" hx-swap="outerHTML">
      <label>Handle <input type="text" name="handle" placeholder="alice-dev" required></label>
      <label>Fingerprint <input type="text" name="fingerprint" placeholder="sha256:..." required></label>
      <label>Agents (optional) <input type="text" name="agents" placeholder="agent1, agent2"></label>
      <button type="submit" class="primary">Add friend</button>
    </form>
    ${renderFriendsTable(friends)}
  `;
}

export function handleAddFriend(
  req: express.Request,
  res: express.Response,
  holder: ConfigHolder,
  configDir: string,
): void {
  const { handle, fingerprint, agents: agentsRaw } = req.body;

  if (!handle || !fingerprint) {
    res.status(400).send(`<div id="friends-table"><p style="color:var(--danger)">Handle and fingerprint are required</p></div>`);
    return;
  }

  const agents = agentsRaw
    ? String(agentsRaw).split(",").map((s: string) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const friends = holder.friends();
    const updated = addFriend(friends, { handle, fingerprint, agents });
    writeFriendsConfig(`${configDir}/friends.toml`, updated);
    // ConfigHolder will pick up the file change within 500ms;
    // render from the updated config directly for instant feedback.
    res.send(renderFriendsTable(updated));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add friend";
    res.status(400).send(`<div id="friends-table"><p style="color:var(--danger)">${message}</p>${renderFriendsTable(holder.friends())}</div>`);
  }
}

export function handleRemoveFriend(
  req: express.Request,
  res: express.Response,
  holder: ConfigHolder,
  configDir: string,
): void {
  const handle = decodeURIComponent(req.params.handle);

  try {
    const friends = holder.friends();
    const updated = removeFriend(friends, handle);
    writeFriendsConfig(`${configDir}/friends.toml`, updated);
    res.send(renderFriendsTable(updated));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove friend";
    res.status(400).send(`<div id="friends-table"><p style="color:var(--danger)">${message}</p>${renderFriendsTable(holder.friends())}</div>`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/dashboard/pages/friends.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/pages/friends.ts test/dashboard/pages/friends.test.ts
git commit -m "feat(dashboard): add friends page with add/remove handlers"
```

---

### Task 6: Threads page

**Files:**
- Create: `src/dashboard/pages/threads.ts`

- [ ] **Step 1: Create the threads page module**

Create `src/dashboard/pages/threads.ts`:

```ts
import type { MessageLog } from "../message-log.js";

function truncateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export function renderThreadsTable(messageLog: MessageLog): string {
  const threads = messageLog.list();

  if (threads.length === 0) {
    return `<div id="threads-table" hx-get="/dashboard/threads/table" hx-trigger="every 5s" hx-swap="outerHTML">
      <p class="placeholder">No threads yet — send a message through the mesh to see activity here</p>
    </div>`;
  }

  const rows = threads.map((t) => `
    <tr>
      <td title="${t.contextId}">${truncateId(t.contextId)}</td>
      <td>${t.participants.join(", ")}</td>
      <td>${t.messageCount}</td>
      <td>${formatTime(t.firstSeen)}</td>
      <td>${formatTime(t.lastActivity)}</td>
    </tr>`).join("");

  return `
    <div id="threads-table" hx-get="/dashboard/threads/table" hx-trigger="every 5s" hx-swap="outerHTML">
      <table>
        <thead>
          <tr><th>Context</th><th>Participants</th><th>Messages</th><th>Started</th><th>Last activity</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderThreadsPage(messageLog: MessageLog): string {
  return `
    <h1>Threads</h1>
    ${renderThreadsTable(messageLog)}
  `;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/pages/threads.ts
git commit -m "feat(dashboard): add threads page rendering from MessageLog"
```

---

### Task 7: Config page

**Files:**
- Create: `src/dashboard/pages/config.ts`

- [ ] **Step 1: Create the config page module**

Create `src/dashboard/pages/config.ts`:

```ts
import fs from "fs";
import path from "path";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(file not found)";
  }
}

export function renderConfigContent(configDir: string): string {
  const files = ["server.toml", "friends.toml", "remotes.toml"];

  return files.map((name) => {
    const content = readFileOrEmpty(path.join(configDir, name));
    return `
      <h2>${name}</h2>
      <pre>${escapeHtml(content)}</pre>`;
  }).join("");
}

export function renderConfigPage(configDir: string): string {
  return `
    <h1>Config</h1>
    <button hx-post="/dashboard/config/reload" hx-target="#config-content" hx-swap="innerHTML" class="primary">
      Reload
    </button>
    <div id="config-content">
      ${renderConfigContent(configDir)}
    </div>
  `;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/pages/config.ts
git commit -m "feat(dashboard): add config viewer page"
```

---

### Task 8: Audit placeholder

**Files:**
- Create: `src/dashboard/pages/audit.ts`

- [ ] **Step 1: Create the audit placeholder**

Create `src/dashboard/pages/audit.ts`:

```ts
export function renderAuditPage(): string {
  return `
    <h1>Audit</h1>
    <p class="placeholder">Audit logging is not yet implemented. See task 02.</p>
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/pages/audit.ts
git commit -m "feat(dashboard): add audit placeholder page"
```

---

### Task 9: mountDashboard — route registration

**Files:**
- Create: `src/dashboard/index.ts`

- [ ] **Step 1: Create the mount function**

Create `src/dashboard/index.ts`:

```ts
import express from "express";
import type { ConfigHolder } from "../config-holder.js";
import { DASHBOARD_CSS } from "./style.js";
import { HTMX_JS } from "./vendor.js";
import { renderLayout } from "./layout.js";
import { renderHomePage, type HomeContext } from "./pages/home.js";
import { renderFriendsPage, renderFriendsTable, handleAddFriend, handleRemoveFriend } from "./pages/friends.js";
import { renderThreadsPage, renderThreadsTable } from "./pages/threads.js";
import { renderConfigPage, renderConfigContent } from "./pages/config.js";
import { renderAuditPage } from "./pages/audit.js";
import type { MessageLog } from "./message-log.js";

export { MessageLog } from "./message-log.js";

export function mountDashboard(
  app: express.Application,
  holder: ConfigHolder,
  configDir: string,
  messageLog: MessageLog,
  startedAt: Date,
): void {
  // Static assets
  app.get("/dashboard/style.css", (_req, res) => {
    res.type("text/css").send(DASHBOARD_CSS);
  });

  app.get("/dashboard/htmx.min.js", (_req, res) => {
    res.type("application/javascript").send(HTMX_JS);
  });

  // Helper: if htmx request, send just the content; otherwise full layout.
  const page = (
    activePage: Parameters<typeof renderLayout>[0]["activePage"],
    title: string,
    content: string,
    req: express.Request,
    res: express.Response,
  ) => {
    if (req.headers["hx-request"]) {
      res.send(content);
    } else {
      res.send(renderLayout({ title, activePage, content }));
    }
  };

  // --- Pages ---

  app.get("/dashboard", (req, res) => {
    const ctx: HomeContext = { holder, configDir, startedAt };
    page("home", "Home", renderHomePage(ctx), req, res);
  });

  app.get("/dashboard/friends", (req, res) => {
    page("friends", "Friends", renderFriendsPage(holder), req, res);
  });

  app.get("/dashboard/friends/table", (_req, res) => {
    res.send(renderFriendsTable(holder.friends()));
  });

  // Body parsing for dashboard form submissions (url-encoded)
  const formParser = express.urlencoded({ extended: false });

  app.post("/dashboard/friends", formParser, (req, res) => {
    handleAddFriend(req, res, holder, configDir);
  });

  app.delete("/dashboard/friends/:handle", (req, res) => {
    handleRemoveFriend(req, res, holder, configDir);
  });

  app.get("/dashboard/threads", (req, res) => {
    page("threads", "Threads", renderThreadsPage(messageLog), req, res);
  });

  app.get("/dashboard/threads/table", (_req, res) => {
    res.send(renderThreadsTable(messageLog));
  });

  app.get("/dashboard/config", (req, res) => {
    page("config", "Config", renderConfigPage(configDir), req, res);
  });

  app.post("/dashboard/config/reload", (_req, res) => {
    // ConfigHolder re-reads on next access after file change;
    // force-reading the files gives fresh content for the config viewer.
    res.send(renderConfigContent(configDir));
  });

  app.get("/dashboard/audit", (req, res) => {
    page("audit", "Audit", renderAuditPage(), req, res);
  });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/index.ts
git commit -m "feat(dashboard): add mountDashboard route registration"
```

---

### Task 10: Wire into server.ts

**Files:**
- Modify: `src/server.ts`

This task modifies `server.ts` to: create a `MessageLog`, pass it into both apps for recording, call `mountDashboard()` on the local app, and print the dashboard URL on startup.

- [ ] **Step 1: Add imports and create MessageLog in startServer**

At the top of `src/server.ts`, add the import:

```ts
import { mountDashboard, MessageLog } from "./dashboard/index.js";
```

In `startServer()`, before the `createPublicApp` / `createLocalApp` calls, create the MessageLog and startedAt:

```ts
const messageLog = new MessageLog(200);
const startedAt = new Date();
```

Update the `createLocalApp` call to pass the new arguments:

```ts
const localApp = createLocalApp(holder, remoteAgents, opts.configDir, messageLog, startedAt);
```

Update the `createPublicApp` call to pass the messageLog:

```ts
const publicApp = createPublicApp(
  holder,
  opts.configDir,
  serverBucket,
  getOrCreateAgentBucket,
  remoteAgents,
  messageLog,
);
```

Add a console.log for the dashboard URL after the existing ones:

```ts
console.log(
  `Dashboard: http://127.0.0.1:${initialServer.server.localPort}/dashboard`,
);
```

- [ ] **Step 2: Update createLocalApp signature and mount dashboard**

Update the `createLocalApp` function signature to accept the new params:

```ts
function createLocalApp(
  holder: ConfigHolder,
  remoteAgents: RemoteAgent[],
  configDir: string,
  messageLog: MessageLog,
  startedAt: Date,
): express.Application {
```

At the end of `createLocalApp`, before `return app;`, add:

```ts
mountDashboard(app, holder, configDir, messageLog, startedAt);
```

- [ ] **Step 3: Record messages in createLocalApp proxy handlers**

In the `app.post("/:tenant/:action", ...)` handler in `createLocalApp`, after the `senderAgent` validation and tenant/action extraction, add a `messageLog.record()` call. Place it just before the `const remote = mapLocalTenantToRemote(...)` line:

```ts
const contextId = req.body?.message?.contextId;
messageLog.record({ contextId, agent: senderAgent });
```

- [ ] **Step 4: Update createPublicApp signature and record messages**

Update `createPublicApp` to accept `messageLog`:

```ts
function createPublicApp(
  holder: ConfigHolder,
  configDir: string,
  serverBucket: TokenBucket,
  getOrCreateAgentBucket: (name: string) => TokenBucket | null,
  remoteAgents: RemoteAgent[],
  messageLog: MessageLog,
): express.Application {
```

In the `app.post("/:tenant/:action", ...)` handler in `createPublicApp`, after step 6 (agent scope check) and before step 6.5, add:

```ts
const contextId = req.body?.message?.contextId;
messageLog.record({ contextId, agent: tenant });
```

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(dashboard): wire MessageLog and mountDashboard into server"
```

---

### Task 11: E2E test — dashboard serves and responds

**Files:**
- Create: `test/dashboard/dashboard-e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

Create `test/dashboard/dashboard-e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../../src/identity.js";
import { startServer } from "../../src/server.js";

describe("dashboard e2e", () => {
  let tmpDir: string;
  let configDir: string;
  let server: { close: () => void };
  let localPort: number;
  let mockAgent: http.Server;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-e2e-"));
    configDir = tmpDir;

    await generateIdentity({
      name: "test-peer",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    localPort = 19901 + Math.floor(Math.random() * 1000);
    const publicPort = 19900 + Math.floor(Math.random() * 1000);

    // Mock agent
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.post("/message\\:send", (_req, res) => {
      res.json({ id: "t1", contextId: "ctx-1", status: { state: "completed" }, artifacts: [] });
    });
    mockAgent = agentApp.listen(0, "127.0.0.1");
    const agentPort = (mockAgent.address() as any).port;

    const serverToml = {
      server: { port: publicPort, host: "127.0.0.1", localPort, rateLimit: "100/hour", streamTimeoutSeconds: 300 },
      agents: { "test-agent": { localEndpoint: `http://127.0.0.1:${agentPort}`, rateLimit: "50/hour", description: "A test agent", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    };
    fs.writeFileSync(path.join(configDir, "server.toml"), TOML.stringify(serverToml as any));

    const friendsToml = {
      friends: {
        alice: { fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
    };
    fs.writeFileSync(path.join(configDir, "friends.toml"), TOML.stringify(friendsToml as any));

    server = await startServer({ configDir });
  });

  afterAll(() => {
    server.close();
    mockAgent.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("GET /dashboard returns full HTML with home page", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("tidepool");
    expect(html).toContain("Home");
    expect(html).toContain("test-agent");
  });

  it("GET /dashboard/style.css returns CSS", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("--bg:");
  });

  it("GET /dashboard/htmx.min.js returns JS", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/htmx.min.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("GET /dashboard/friends returns friends page with alice", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/friends`);
    const html = await res.text();
    expect(html).toContain("alice");
    expect(html).toContain("sha256:aaaaaa");
  });

  it("GET /dashboard/threads returns threads page", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/threads`);
    const html = await res.text();
    expect(html).toContain("Threads");
  });

  it("GET /dashboard/config returns config page with TOML content", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/config`);
    const html = await res.text();
    expect(html).toContain("server.toml");
    expect(html).toContain("test-agent");
  });

  it("GET /dashboard/audit returns placeholder", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/audit`);
    const html = await res.text();
    expect(html).toContain("not yet implemented");
  });

  it("htmx fragment request returns content without layout", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/friends`, {
      headers: { "HX-Request": "true" },
    });
    const html = await res.text();
    expect(html).toContain("alice");
    expect(html).not.toContain("<!DOCTYPE html>");
  });

  it("POST /dashboard/friends adds a friend", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/friends`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "handle=bob&fingerprint=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("bob");

    // Verify written to disk
    const content = fs.readFileSync(path.join(configDir, "friends.toml"), "utf-8");
    expect(content).toContain("bob");
  });

  it("DELETE /dashboard/friends/:handle removes a friend", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/friends/bob`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("bob");

    // Verify removed from disk
    const content = fs.readFileSync(path.join(configDir, "friends.toml"), "utf-8");
    expect(content).not.toContain("bob");
  });
});
```

- [ ] **Step 2: Run the E2E test**

Run: `npx vitest run test/dashboard/dashboard-e2e.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add test/dashboard/dashboard-e2e.test.ts
git commit -m "test(dashboard): add e2e tests for all dashboard routes"
```

---

### Task 12: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All existing tests still pass, plus new dashboard tests

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Final commit if any fixes needed**

If any tests required fixes, commit those fixes with a descriptive message.
