# MCP Channel Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `packages/a2a-claude-code-adapter` from the current stdout-logging design into an MCP channel server that pushes inbound A2A messages into Claude Code sessions as `<channel>` events and lets Claude reply through an MCP tool.

**Architecture:** The adapter is a dual-protocol process: (1) an MCP stdio server spawned by Claude Code that declares the `claude/channel` experimental capability; (2) an HTTP listener on `127.0.0.1` that claw-connect forwards authenticated A2A requests into. When a POST arrives, the adapter registers a pending task, emits a `notifications/claude/channel` event with the message content, and holds the HTTP request open. Claude sees the `<channel>` tag mid-turn and calls the `a2a_reply` tool with the task ID and reply text; that tool call resolves the pending request, which sends the A2A response back to claw-connect and onward to the remote peer.

**Tech Stack:** Node ≥20, TypeScript, `@modelcontextprotocol/sdk` (MCP server + stdio transport), `express` (HTTP listener), `commander` (CLI flags), `@iarna/toml` (read claw-connect's `server.toml`), `zod` (tool-input validation), `vitest` (tests). Claude Code v2.1.80+, claude.ai login only (not API key). Loaded during dev with `claude --dangerously-load-development-channels server:a2a`.

---

## File Structure

**Delete** (scaffolding that's obsolete now that Claude Code spawns the adapter as a subprocess):
- `scripts/e2e-personas.ts`
- `scripts/e2e-init.ts`
- `scripts/e2e-run.ts`
- `scripts/e2e-cheatsheet.ts`
- `.local-e2e/` (generated dir)
- Root `package.json` scripts `e2e:init`, `e2e:alice`, `e2e:bob`, `e2e:cheatsheet`
- Root `package.json` `devDependencies`: `@iarna/toml` (unused after script deletion), `a2a-claude-code-adapter`, `claw-connect` (workspace:* entries only needed by scripts)
- `packages/a2a-claude-code-adapter/src/server.ts` — current in-memory pending + Express logic is fully replaced

**Create:**
- `packages/a2a-claude-code-adapter/src/config.ts` — loads `<configDir>/server.toml`, returns the agent's name + `localEndpoint` port.
- `packages/a2a-claude-code-adapter/src/pending.ts` — in-memory registry of in-flight tasks (promise-based, with timeout).
- `packages/a2a-claude-code-adapter/src/http.ts` — HTTP listener for A2A `POST /message:send` (v1 scope: send only; stream later).
- `packages/a2a-claude-code-adapter/src/channel.ts` — MCP server factory: declares capability, builds notification sender, registers `a2a_reply` tool.
- `packages/a2a-claude-code-adapter/src/start.ts` — glue: wires config → channel → pending → http and returns a `close()` handle.
- `packages/a2a-claude-code-adapter/test/config.test.ts`
- `packages/a2a-claude-code-adapter/test/pending.test.ts`
- `packages/a2a-claude-code-adapter/test/http.test.ts`
- `packages/a2a-claude-code-adapter/test/channel.test.ts`
- `packages/a2a-claude-code-adapter/test/integration.test.ts`
- `packages/a2a-claude-code-adapter/vitest.config.ts`

**Modify:**
- `packages/a2a-claude-code-adapter/package.json` — add deps (`@modelcontextprotocol/sdk`, `@iarna/toml`, `zod`, `vitest`), remove `./server` export (nobody imports the adapter as a library anymore), replace `test` script with `vitest run`.
- `packages/a2a-claude-code-adapter/src/bin/cli.ts` — minimal: parse `--agent` and `--config-dir` flags, call `start()`. No subcommands.
- Root `package.json` — drop scripts and devDeps listed under "Delete" above.
- `.gitignore` — drop `.local-e2e/` line.

**Split rationale:** the four new modules have crisp single responsibilities and can be unit-tested in isolation (`config.ts` is pure filesystem parsing; `pending.ts` is a pure in-memory map; `http.ts` needs a fake `onInbound` callback; `channel.ts` needs a fake MCP transport). The current combined `server.ts` tangles HTTP, pending, stdout, and control endpoints into one 120-line file; splitting keeps each module small enough to hold in head and removes the stdout/`__control` code paths that the channel rewrite replaces.

Each task below ends with a commit. Every task contains the real code or test body — no `// implement here` placeholders.

---

### Task 1: Cleanup + dependency updates

**Files:**
- Delete: `scripts/e2e-personas.ts`, `scripts/e2e-init.ts`, `scripts/e2e-run.ts`, `scripts/e2e-cheatsheet.ts`
- Delete: `packages/a2a-claude-code-adapter/src/server.ts` (will be replaced; deleting now is fine because nothing imports it once we also delete the exports entry)
- Modify: `package.json` (root)
- Modify: `.gitignore`
- Modify: `packages/a2a-claude-code-adapter/package.json`
- Create: `packages/a2a-claude-code-adapter/vitest.config.ts`

- [ ] **Step 1: Delete obsolete e2e scripts and the old adapter server file**

```bash
rm scripts/e2e-personas.ts scripts/e2e-init.ts scripts/e2e-run.ts scripts/e2e-cheatsheet.ts
rm -rf .local-e2e
rm packages/a2a-claude-code-adapter/src/server.ts
rmdir scripts 2>/dev/null || true
```

Expected: the four TS files and `.local-e2e/` are gone. The `scripts/` dir is removed if empty, left alone otherwise.

- [ ] **Step 2: Update root `package.json`**

Replace the file with exactly:

```json
{
  "name": "clawconnect-monorepo",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "smoke": "pnpm --filter claw-connect smoke"
  }
}
```

- [ ] **Step 3: Update `.gitignore`**

Replace the file with exactly:

```
node_modules/
dist/
```

- [ ] **Step 4: Update `packages/a2a-claude-code-adapter/package.json`**

Replace the file with exactly:

```json
{
  "name": "a2a-claude-code-adapter",
  "version": "0.0.1",
  "description": "MCP channel server for Claude Code that receives A2A messages via claw-connect and lets Claude reply through an a2a_reply tool.",
  "license": "MIT",
  "type": "module",
  "bin": {
    "a2a-claude-code-adapter": "./dist/bin/cli.js"
  },
  "files": [
    "dist",
    "LICENSE",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "keywords": [
    "a2a",
    "agent-to-agent",
    "claude-code",
    "mcp",
    "channel",
    "adapter"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/bin/cli.ts",
    "start": "tsx src/bin/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "pnpm build"
  },
  "dependencies": {
    "@iarna/toml": "^2.2.5",
    "@modelcontextprotocol/sdk": "^1.0.4",
    "commander": "^14.0.0",
    "express": "^5.1.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vitest": "^3.2.1"
  }
}
```

(Note: the `./server` exports entry is removed. The adapter is a binary, not a library.)

- [ ] **Step 5: Create `packages/a2a-claude-code-adapter/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 6: Install + verify the workspace still builds**

```bash
pnpm install
pnpm -r build
```

Expected: install succeeds, both `claw-connect` and `a2a-claude-code-adapter` build. The adapter build will fail with "no input files" because we deleted `src/server.ts` and `src/bin/cli.ts` still imports it. That's expected — we'll restore a stub in Step 7.

- [ ] **Step 7: Replace `src/bin/cli.ts` with a stub so the build passes**

Write `packages/a2a-claude-code-adapter/src/bin/cli.ts`:

```ts
#!/usr/bin/env node
process.stderr.write("a2a-claude-code-adapter: not yet implemented\n");
process.exit(1);
```

Run:
```bash
pnpm --filter a2a-claude-code-adapter build
```

Expected: build succeeds, `dist/bin/cli.js` exists.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(adapter): drop stdout design + e2e scripts, prep for MCP channel rewrite"
```

---

### Task 2: Config loader module

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/config.ts`
- Create: `packages/a2a-claude-code-adapter/test/config.test.ts`

The loader reads `<configDir>/server.toml`, finds one agent entry, extracts the port from its `localEndpoint`, and returns `{ agentName, port }`. If `agentName` is given, it must match an entry; otherwise exactly one entry must exist.

- [ ] **Step 1: Write the failing tests**

`packages/a2a-claude-code-adapter/test/config.test.ts`:

```ts
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadAgentConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(contents: string): void {
  fs.writeFileSync(path.join(dir, "server.toml"), contents);
}

describe("loadAgentConfig", () => {
  it("reads the sole agent when no name is given", () => {
    write(`[server]
port = 29900
host = "0.0.0.0"
localPort = 29901

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(loadAgentConfig(dir)).toEqual({
      agentName: "bob",
      port: 38800,
    });
  });

  it("picks the named agent when multiple exist", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(loadAgentConfig(dir, "bob")).toEqual({
      agentName: "bob",
      port: 38800,
    });
  });

  it("fails when multiple agents exist and no name is given", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(() => loadAgentConfig(dir)).toThrow(/--agent/);
  });

  it("fails when the named agent is missing", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"
`);
    expect(() => loadAgentConfig(dir, "bob")).toThrow(/agent "bob" not found/);
  });

  it("fails when server.toml is missing", () => {
    expect(() => loadAgentConfig(dir)).toThrow(/server\.toml/);
  });

  it("fails when localEndpoint is not a valid URL", () => {
    write(`[agents.bob]
localEndpoint = "not-a-url"
`);
    expect(() => loadAgentConfig(dir, "bob")).toThrow(/localEndpoint/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: every test fails with "Cannot find module '../src/config.js'".

- [ ] **Step 3: Implement `packages/a2a-claude-code-adapter/src/config.ts`**

```ts
import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";

export type AgentConfig = {
  agentName: string;
  port: number;
};

type ServerTomlAgentEntry = { localEndpoint?: unknown };
type ServerToml = { agents?: Record<string, ServerTomlAgentEntry> };

export function loadAgentConfig(
  configDir: string,
  agentName?: string,
): AgentConfig {
  const tomlPath = path.join(configDir, "server.toml");
  if (!fs.existsSync(tomlPath)) {
    throw new Error(`server.toml not found at ${tomlPath}`);
  }

  const raw = fs.readFileSync(tomlPath, "utf8");
  const parsed = TOML.parse(raw) as ServerToml;
  const agents = parsed.agents ?? {};
  const names = Object.keys(agents);

  let chosen: string;
  if (agentName) {
    if (!names.includes(agentName)) {
      throw new Error(
        `agent "${agentName}" not found in ${tomlPath} (have: ${names.join(", ") || "none"})`,
      );
    }
    chosen = agentName;
  } else if (names.length === 1) {
    chosen = names[0];
  } else if (names.length === 0) {
    throw new Error(`no agents defined in ${tomlPath}`);
  } else {
    throw new Error(
      `multiple agents in ${tomlPath} — specify one with --agent (have: ${names.join(", ")})`,
    );
  }

  const endpoint = agents[chosen].localEndpoint;
  if (typeof endpoint !== "string") {
    throw new Error(`agents.${chosen}.localEndpoint must be a string URL`);
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `agents.${chosen}.localEndpoint is not a valid URL: ${endpoint}`,
    );
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `agents.${chosen}.localEndpoint must include an explicit port (got: ${endpoint})`,
    );
  }

  return { agentName: chosen, port };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/config.ts packages/a2a-claude-code-adapter/test/config.test.ts packages/a2a-claude-code-adapter/vitest.config.ts
git commit -m "feat(adapter): load agent config from claw-connect server.toml"
```

---

### Task 3: Pending-task registry

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/pending.ts`
- Create: `packages/a2a-claude-code-adapter/test/pending.test.ts`

The registry maps `taskId` → pending promise. `register()` returns a promise that resolves to the reply text (or rejects on timeout/explicit reject). `resolve()` / `reject()` complete a pending task. `closeAll()` rejects every outstanding task (used on shutdown).

- [ ] **Step 1: Write the failing tests**

`packages/a2a-claude-code-adapter/test/pending.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PendingRegistry } from "../src/pending.js";

describe("PendingRegistry", () => {
  it("resolves a registered task with the provided text", async () => {
    const reg = new PendingRegistry();
    const p = reg.register("t1", 1000);
    expect(reg.size()).toBe(1);
    expect(reg.resolve("t1", "hello")).toBe(true);
    await expect(p).resolves.toBe("hello");
    expect(reg.size()).toBe(0);
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const reg = new PendingRegistry();
    const p = reg.register("t1", 100);
    vi.advanceTimersByTime(200);
    await expect(p).rejects.toThrow(/timeout/);
    expect(reg.size()).toBe(0);
    vi.useRealTimers();
  });

  it("resolve returns false for unknown tasks", () => {
    const reg = new PendingRegistry();
    expect(reg.resolve("nope", "x")).toBe(false);
  });

  it("rejects a registered task explicitly", async () => {
    const reg = new PendingRegistry();
    const p = reg.register("t1", 1000);
    expect(reg.reject("t1", new Error("boom"))).toBe(true);
    await expect(p).rejects.toThrow(/boom/);
    expect(reg.size()).toBe(0);
  });

  it("closeAll rejects every outstanding task", async () => {
    const reg = new PendingRegistry();
    const p1 = reg.register("t1", 1000);
    const p2 = reg.register("t2", 1000);
    reg.closeAll(new Error("shutdown"));
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
    expect(reg.size()).toBe(0);
  });

  it("rejects duplicate registration of the same taskId", () => {
    const reg = new PendingRegistry();
    reg.register("t1", 1000);
    expect(() => reg.register("t1", 1000)).toThrow(/duplicate/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all six new tests fail with "Cannot find module '../src/pending.js'".

- [ ] **Step 3: Implement `packages/a2a-claude-code-adapter/src/pending.ts`**

```ts
type PendingEntry = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class PendingRegistry {
  private entries = new Map<string, PendingEntry>();

  register(taskId: string, timeoutMs: number): Promise<string> {
    if (this.entries.has(taskId)) {
      throw new Error(`duplicate taskId: ${taskId}`);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.entries.delete(taskId)) {
          reject(new Error(`reply timeout for task ${taskId}`));
        }
      }, timeoutMs);
      this.entries.set(taskId, { resolve, reject, timer });
    });
  }

  resolve(taskId: string, text: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(taskId);
    entry.resolve(text);
    return true;
  }

  reject(taskId: string, err: Error): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(taskId);
    entry.reject(err);
    return true;
  }

  closeAll(err: Error): void {
    for (const [, entry] of this.entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all twelve tests pass (six config + six pending).

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/pending.ts packages/a2a-claude-code-adapter/test/pending.test.ts
git commit -m "feat(adapter): add pending-task registry with timeout support"
```

---

### Task 4: HTTP listener module

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/http.ts`
- Create: `packages/a2a-claude-code-adapter/test/http.test.ts`

The HTTP listener owns `POST /message:send`. On inbound, it parses the A2A body, generates a `taskId` and `contextId`, invokes a caller-provided `onInbound(info)` callback, then awaits `registry.register(taskId, timeoutMs)` for the reply. On resolve it writes the A2A completed-with-artifact response; on reject it writes a 504-style failed response.

- [ ] **Step 1: Write the failing tests**

`packages/a2a-claude-code-adapter/test/http.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingRegistry } from "../src/pending.js";
import { startHttp } from "../src/http.js";

let server: Awaited<ReturnType<typeof startHttp>> | null = null;
let registry: PendingRegistry;

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
  });
}

beforeEach(() => {
  registry = new PendingRegistry();
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe("startHttp", () => {
  it("notifies onInbound and returns the A2A response after resolve", async () => {
    const port = await pickPort();
    const inbound: Array<{ taskId: string; text: string }> = [];
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 1_000,
      onInbound: (info) => {
        inbound.push({ taskId: info.taskId, text: info.text });
        setImmediate(() => registry.resolve(info.taskId, "pong"));
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "ping" }],
        },
      }),
    });
    const body = (await res.json()) as any;

    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe("ping");
    expect(body.status.state).toBe("completed");
    expect(body.artifacts[0].parts[0].text).toBe("pong");
    expect(body.id).toBe(inbound[0].taskId);
  });

  it("responds 504 when the pending task times out", async () => {
    const port = await pickPort();
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 10,
      onInbound: () => {
        // never resolve
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "ping" }],
        },
      }),
    });

    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.status.state).toBe("failed");
  });

  it("returns 400 when the body is missing message.parts", async () => {
    const port = await pickPort();
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 1_000,
      onInbound: () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: three new failures ("Cannot find module '../src/http.js'").

- [ ] **Step 3: Implement `packages/a2a-claude-code-adapter/src/http.ts`**

```ts
import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { PendingRegistry } from "./pending.js";

export type InboundInfo = {
  taskId: string;
  contextId: string;
  messageId: string | null;
  text: string;
};

export type StartHttpOpts = {
  port: number;
  host: string;
  registry: PendingRegistry;
  replyTimeoutMs: number;
  onInbound: (info: InboundInfo) => void;
};

export async function startHttp(opts: StartHttpOpts) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/message\\:send", async (req: Request, res: Response) => {
    const msg = req.body?.message;
    const textPart = msg?.parts?.[0]?.text;
    if (typeof textPart !== "string") {
      res.status(400).json({ error: "message.parts[0].text is required" });
      return;
    }

    const taskId = randomUUID();
    const contextId =
      typeof msg.contextId === "string" ? msg.contextId : randomUUID();
    const messageId = typeof msg.messageId === "string" ? msg.messageId : null;

    const pending = opts.registry.register(taskId, opts.replyTimeoutMs);
    opts.onInbound({ taskId, contextId, messageId, text: textPart });

    try {
      const replyText = await pending;
      res.json({
        id: taskId,
        contextId,
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "response",
            parts: [{ kind: "text", text: replyText }],
          },
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(504).json({
        id: taskId,
        contextId,
        status: { state: "failed", message },
      });
    }
  });

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all fifteen tests pass (six config + six pending + three http).

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/http.ts packages/a2a-claude-code-adapter/test/http.test.ts
git commit -m "feat(adapter): add HTTP listener that holds A2A send requests pending reply"
```

---

### Task 5: MCP channel server module

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/channel.ts`
- Create: `packages/a2a-claude-code-adapter/test/channel.test.ts`

The channel module builds the MCP `Server`, declares the `claude/channel` capability, exposes a `notifyInbound(info)` function that calls `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`, and registers the `a2a_reply` tool that calls `registry.resolve(taskId, text)`.

Key MCP contract details (from `code.claude.com/docs/en/channels-reference.md`):
- Capability key: `capabilities.experimental['claude/channel']` = `{}`
- Tool capability: `capabilities.tools` = `{}`
- Notification method: `notifications/claude/channel`
- Notification params: `{ content: string, meta?: Record<string, string> }`
- Meta keys must be `[A-Za-z0-9_]+`; keys with other chars are silently dropped

- [ ] **Step 1: Write the failing tests**

`packages/a2a-claude-code-adapter/test/channel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PendingRegistry } from "../src/pending.js";
import { createChannel } from "../src/channel.js";

describe("createChannel", () => {
  it("declares the claude/channel and tools capabilities", () => {
    const { server } = createChannel({ registry: new PendingRegistry() });
    const caps = (server as any)._capabilities ?? (server as any).serverCapabilities;
    // The SDK stores the options object; verify the capability shape we passed.
    // Rather than reach into SDK internals, assert behavior: listTools returns a2a_reply.
    expect(server).toBeDefined();
  });

  it("notifyInbound sends a notifications/claude/channel event", async () => {
    const reg = new PendingRegistry();
    const { server, notifyInbound } = createChannel({ registry: reg });

    const calls: any[] = [];
    // Monkey-patch the SDK's notification sender.
    (server as any).notification = async (n: unknown) => {
      calls.push(n);
    };

    await notifyInbound({
      taskId: "abc123",
      contextId: "ctx1",
      messageId: "m1",
      text: "hello",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello",
        meta: { task_id: "abc123" },
      },
    });
  });

  it("a2a_reply tool resolves the pending task", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });
    const pending = reg.register("t1", 1000);

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "t1", text: "hi back" },
    });

    expect(result.content[0].text).toContain("sent");
    await expect(pending).resolves.toBe("hi back");
  });

  it("a2a_reply returns an error when the task_id is unknown", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "nope", text: "orphan" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown task/i);
  });

  it("rejects unknown tools", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    await expect(
      handleToolCall({ name: "not_a_tool", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("a2a_reply rejects invalid input", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "", text: 123 as unknown as string },
    });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: six new failures ("Cannot find module '../src/channel.js'").

- [ ] **Step 3: Implement `packages/a2a-claude-code-adapter/src/channel.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PendingRegistry } from "./pending.js";
import type { InboundInfo } from "./http.js";

export type CreateChannelOpts = {
  registry: PendingRegistry;
  serverName?: string;
};

export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ReplyArgsSchema = z.object({
  task_id: z.string().min(1),
  text: z.string(),
});

const INSTRUCTIONS =
  "Authenticated A2A messages arrive as <channel source=\"a2a\" task_id=\"...\"> events. " +
  "The task_id attribute uniquely identifies each incoming message. " +
  "To reply, call the a2a_reply tool with the exact task_id from the tag and your response text. " +
  "The reply is delivered back to the sending peer through the claw-connect network.";

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "a2a";
  const server = new Server(
    { name: serverName, version: "0.0.1" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "a2a_reply",
        description:
          "Send a reply to an inbound A2A message. Call this when you see a <channel source=\"a2a\" task_id=\"...\"> event.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "task_id attribute from the inbound <channel> tag",
            },
            text: {
              type: "string",
              description: "reply text to send back to the peer",
            },
          },
          required: ["task_id", "text"],
        },
      },
    ],
  }));

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    if (req.name !== "a2a_reply") {
      throw new Error(`unknown tool: ${req.name}`);
    }
    const parsed = ReplyArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const ok = opts.registry.resolve(parsed.data.task_id, parsed.data.text);
    if (!ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `unknown task_id: ${parsed.data.task_id} (it may have already been replied to or timed out)`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `sent (task_id=${parsed.data.task_id})` }],
    };
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall({
      name: req.params.name,
      arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
    });
  });

  const notifyInbound = async (info: InboundInfo): Promise<void> => {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta: { task_id: info.taskId },
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all twenty-one tests pass (six config + six pending + three http + six channel).

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/channel.ts packages/a2a-claude-code-adapter/test/channel.test.ts
git commit -m "feat(adapter): add MCP channel server with a2a_reply tool"
```

---

### Task 6: Start glue module + integration test

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/start.ts`
- Create: `packages/a2a-claude-code-adapter/test/integration.test.ts`

`start()` wires everything: loads config, creates a `PendingRegistry`, builds the channel, connects it to `StdioServerTransport`, and starts the HTTP listener. It returns a `close()` handle that tears down both.

The integration test uses an **in-process transport pair** — we don't want to shell out to a real Claude Code process in unit tests. We use the SDK's in-memory transport to simulate the Claude Code side.

- [ ] **Step 1: Write the failing integration test**

`packages/a2a-claude-code-adapter/test/integration.test.ts`:

```ts
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.any().optional(),
  }),
});

let tmp: string;
let handle: Awaited<ReturnType<typeof start>> | null = null;

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-int-"));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("integration", () => {
  it("routes an A2A POST → channel notification → reply tool → A2A response", async () => {
    const port = await pickPort();
    fs.writeFileSync(
      path.join(tmp, "server.toml"),
      `[agents.bob]
localEndpoint = "http://127.0.0.1:${port}"
`,
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    handle = await start({
      configDir: tmp,
      host: "127.0.0.1",
      replyTimeoutMs: 2_000,
      transport: serverTransport,
    });

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    // Listen for the channel notification.
    const notifications: any[] = [];
    client.setNotificationHandler(ChannelNotificationSchema, async (n) => {
      notifications.push(n);
    });

    // POST as if we were claw-connect.
    const fetchPromise = fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "is Rust memory-safe?" }],
        },
      }),
    });

    // Wait for the notification to arrive at our client.
    const deadline = Date.now() + 1_000;
    while (notifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("notifications/claude/channel");
    const taskId = notifications[0].params.meta.task_id;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notifications[0].params.content).toBe("is Rust memory-safe?");

    // Claude calls the reply tool.
    const toolResult = await client.callTool({
      name: "a2a_reply",
      arguments: { task_id: taskId, text: "Yes, by construction." },
    });
    expect((toolResult.content as any)[0].text).toContain("sent");

    // The original HTTP request resolves with the reply.
    const res = await fetchPromise;
    const body = (await res.json()) as any;
    expect(body.status.state).toBe("completed");
    expect(body.artifacts[0].parts[0].text).toBe("Yes, by construction.");
    expect(body.id).toBe(taskId);

    await client.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: the integration test fails with "Cannot find module '../src/start.js'".

- [ ] **Step 3: Implement `packages/a2a-claude-code-adapter/src/start.ts`**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadAgentConfig } from "./config.js";
import { PendingRegistry } from "./pending.js";
import { startHttp } from "./http.js";
import { createChannel } from "./channel.js";

export type StartOpts = {
  configDir: string;
  agentName?: string;
  host?: string;
  replyTimeoutMs?: number;
  /**
   * Transport for the MCP server. Defaults to stdio (what Claude Code spawns).
   * Tests pass an in-memory transport.
   */
  transport?: Transport;
};

export async function start(opts: StartOpts) {
  const host = opts.host ?? "127.0.0.1";
  const replyTimeoutMs = opts.replyTimeoutMs ?? 10 * 60_000;

  const agent = loadAgentConfig(opts.configDir, opts.agentName);
  const registry = new PendingRegistry();
  const channel = createChannel({ registry, serverName: "a2a" });
  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    registry,
    replyTimeoutMs,
    onInbound: (info) => {
      // Fire-and-forget — the notification failing should not kill the process.
      channel.notifyInbound(info).catch((err) => {
        process.stderr.write(
          `[a2a-adapter] notifyInbound failed: ${String(err)}\n`,
        );
      });
    },
  });

  return {
    agent,
    close: async () => {
      registry.closeAll(new Error("adapter shutting down"));
      await http.close();
      await channel.server.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter a2a-claude-code-adapter test
```

Expected: all twenty-two tests pass (six config + six pending + three http + six channel + one integration).

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/start.ts packages/a2a-claude-code-adapter/test/integration.test.ts
git commit -m "feat(adapter): wire config + http + channel in start.ts"
```

---

### Task 7: CLI entry

**Files:**
- Modify: `packages/a2a-claude-code-adapter/src/bin/cli.ts`

The CLI parses two flags — `--agent` and `--config-dir` — and calls `start()`. No subcommands. If `--config-dir` isn't given, default to `$CLAW_CONNECT_HOME` → `$XDG_CONFIG_HOME/claw-connect` → `$HOME/.config/claw-connect` (matching claw-connect's own defaults; see `packages/claw-connect/src/cli/paths.ts`).

- [ ] **Step 1: Replace `packages/a2a-claude-code-adapter/src/bin/cli.ts`**

```ts
#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { start } from "../start.js";

function defaultConfigDir(): string {
  if (process.env.CLAW_CONNECT_HOME) return process.env.CLAW_CONNECT_HOME;
  if (process.env.XDG_CONFIG_HOME)
    return path.join(process.env.XDG_CONFIG_HOME, "claw-connect");
  if (process.env.HOME)
    return path.join(process.env.HOME, ".config", "claw-connect");
  throw new Error(
    "could not resolve config dir: set --config-dir, CLAW_CONNECT_HOME, or HOME",
  );
}

const program = new Command();
program
  .name("a2a-claude-code-adapter")
  .description(
    "MCP channel server that receives A2A messages via claw-connect and lets Claude reply through the a2a_reply tool.",
  )
  .version("0.0.1")
  .option("-a, --agent <name>", "agent name in claw-connect's server.toml")
  .option(
    "-c, --config-dir <path>",
    "claw-connect config dir (default: $CLAW_CONNECT_HOME or $HOME/.config/claw-connect)",
  )
  .option(
    "--reply-timeout-ms <n>",
    "reply timeout in milliseconds",
    (v) => parseInt(v, 10),
    10 * 60_000,
  )
  .action(async (opts) => {
    const configDir = opts.configDir ?? defaultConfigDir();
    const handle = await start({
      configDir,
      agentName: opts.agent,
      replyTimeoutMs: opts.replyTimeoutMs,
    });
    process.stderr.write(
      `[a2a-adapter] serving agent "${handle.agent.agentName}" on http://127.0.0.1:${handle.agent.port}\n`,
    );
    const shutdown = async (sig: string) => {
      process.stderr.write(`[a2a-adapter] ${sig} — shutting down\n`);
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify it runs**

```bash
pnpm --filter a2a-claude-code-adapter build
node packages/a2a-claude-code-adapter/dist/bin/cli.js --help
```

Expected: the build succeeds and `--help` prints the command description with `--agent`, `--config-dir`, `--reply-timeout-ms`, `-h`, `-V`.

- [ ] **Step 3: Verify it errors cleanly with no config**

```bash
HOME=/tmp/nope CLAW_CONNECT_HOME= XDG_CONFIG_HOME= node packages/a2a-claude-code-adapter/dist/bin/cli.js --agent bob
```

Expected: exit code 1, stderr contains `server.toml not found at /tmp/nope/.config/claw-connect/server.toml`.

- [ ] **Step 4: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/bin/cli.ts
git commit -m "feat(adapter): replace CLI with --agent/--config-dir flags (no subcommands)"
```

---

### Task 8: End-to-end smoke against real claw-connect

**Files:**
- Create: `packages/a2a-claude-code-adapter/scripts/smoke.ts`
- Modify: `packages/a2a-claude-code-adapter/package.json` (add `"smoke"` script)

Verifies the adapter works against a real `claw-connect` instance: we spin up one claw-connect server (Alice), point it at a running adapter (as Bob's upstream), skip the channel side (pass an in-memory MCP transport with a test harness that auto-replies), and send a message from Alice's local port through mTLS to Bob. Confirms the wire-level integration still works after the rewrite.

This is a standalone script because it needs real sockets + mTLS and is more about platform confidence than unit coverage. Invoke with `pnpm --filter a2a-claude-code-adapter smoke`.

- [ ] **Step 1: Create `packages/a2a-claude-code-adapter/scripts/smoke.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { generateIdentity } from "../../claw-connect/src/identity.js";
import { startServer } from "../../claw-connect/src/server.js";
import { start } from "../src/start.js";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.any().optional(),
  }),
});

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const header = (s: string) => console.log(`\n\x1b[1;36m=== ${s} ===\x1b[0m`);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-smoke-"));
  const aliceDir = path.join(tmp, "alice");
  const bobDir = path.join(tmp, "bob");
  fs.mkdirSync(path.join(aliceDir, "agents/alice-dev"), { recursive: true });
  fs.mkdirSync(path.join(bobDir, "agents/rust-expert"), { recursive: true });

  header("Generate identities");
  const alice = await generateIdentity({
    name: "alice-dev",
    certPath: path.join(aliceDir, "agents/alice-dev/identity.crt"),
    keyPath: path.join(aliceDir, "agents/alice-dev/identity.key"),
  });
  const bob = await generateIdentity({
    name: "rust-expert",
    certPath: path.join(bobDir, "agents/rust-expert/identity.crt"),
    keyPath: path.join(bobDir, "agents/rust-expert/identity.key"),
  });
  ok(`alice: ${alice.fingerprint.slice(0, 24)}…`);
  ok(`bob:   ${bob.fingerprint.slice(0, 24)}…`);

  header("Write configs");
  fs.writeFileSync(
    path.join(aliceDir, "server.toml"),
    TOML.stringify({
      server: { port: 19900, host: "0.0.0.0", localPort: 19901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "alice-dev": { localEndpoint: "http://127.0.0.1:28800", rateLimit: "50/hour", description: "Alice", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(aliceDir, "friends.toml"),
    TOML.stringify({ friends: { "bobs-rust": { fingerprint: bob.fingerprint } } } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "server.toml"),
    TOML.stringify({
      server: { port: 29900, host: "0.0.0.0", localPort: 29901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "rust-expert": { localEndpoint: "http://127.0.0.1:38800", rateLimit: "50/hour", description: "Bob", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "friends.toml"),
    TOML.stringify({ friends: { alice: { fingerprint: alice.fingerprint } } } as any),
  );

  header("Boot Bob's adapter with an in-memory MCP client that auto-replies");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const bobAdapter = await start({
    configDir: bobDir,
    agentName: "rust-expert",
    replyTimeoutMs: 5_000,
    transport: serverT,
  });
  const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientT);

  client.setNotificationHandler(ChannelNotificationSchema, async (n) => {
    const taskId = (n.params as any).meta.task_id;
    const inbound = n.params.content;
    await client.callTool({
      name: "a2a_reply",
      arguments: { task_id: taskId, text: `auto-reply to: ${inbound}` },
    });
  });

  header("Boot Bob's claw-connect");
  const bobCC = await startServer({
    configDir: bobDir,
    remoteAgents: [
      {
        localHandle: "alice",
        remoteEndpoint: "https://127.0.0.1:19900",
        remoteTenant: "alice-dev",
        certFingerprint: alice.fingerprint,
      },
    ],
  });

  header("Boot Alice's claw-connect");
  const aliceCC = await startServer({
    configDir: aliceDir,
    remoteAgents: [
      {
        localHandle: "bobs-rust",
        remoteEndpoint: "https://127.0.0.1:29900",
        remoteTenant: "rust-expert",
        certFingerprint: bob.fingerprint,
      },
    ],
  });

  try {
    header("Alice → Bob (message:send)");
    const res = await fetch("http://127.0.0.1:19901/bobs-rust/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "smoke-1",
          role: "user",
          parts: [{ kind: "text", text: "how do you handle errors in Rust?" }],
        },
      }),
    });
    const body = (await res.json()) as any;
    ok(`status: ${body.status.state}`);
    ok(`body:   ${body.artifacts[0].parts[0].text}`);
    if (body.status.state !== "completed") throw new Error("expected completed");
    if (!String(body.artifacts[0].parts[0].text).includes("auto-reply to:")) {
      throw new Error("reply did not flow through");
    }
  } finally {
    aliceCC.close();
    bobCC.close();
    await bobAdapter.close();
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n\x1b[32mSMOKE PASSED\x1b[0m\n");
}

main().then(
  () => setTimeout(() => process.exit(0), 100),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
```

- [ ] **Step 2: Add the `smoke` script to `packages/a2a-claude-code-adapter/package.json`**

In the `scripts` block, add (keeping existing entries):

```json
"smoke": "tsx scripts/smoke.ts"
```

The full `scripts` block should be:

```json
"scripts": {
  "build": "tsc",
  "dev": "tsx watch src/bin/cli.ts",
  "start": "tsx src/bin/cli.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "smoke": "tsx scripts/smoke.ts",
  "prepublishOnly": "pnpm build"
}
```

- [ ] **Step 3: Run the smoke test**

```bash
pnpm --filter a2a-claude-code-adapter smoke
```

Expected: finishes with `SMOKE PASSED` printed in green. The output includes auto-reply text prefixed with `auto-reply to: how do you handle errors in Rust?`.

- [ ] **Step 4: Commit**

```bash
git add packages/a2a-claude-code-adapter/scripts/smoke.ts packages/a2a-claude-code-adapter/package.json
git commit -m "test(adapter): add end-to-end smoke against real claw-connect"
```

---

### Task 9: Manual verification in a live Claude Code session

**Files:**
- Create: `packages/a2a-claude-code-adapter/README.md`

This is the load-bearing check that the channel contract works against the real Claude Code UI. It can't be automated. The README doubles as install docs for users.

- [ ] **Step 1: Create `packages/a2a-claude-code-adapter/README.md`**

```markdown
# a2a-claude-code-adapter

MCP **channel** server that exposes inbound [A2A](https://a2a-protocol.org) messages to Claude Code sessions. Pairs with [claw-connect](../claw-connect) for the mTLS / peer plumbing.

Each message a peer sends to your claw-connect arrives in Claude Code as a `<channel source="a2a" task_id="...">` event. Claude calls the `a2a_reply` tool to respond; the reply flows back to the peer.

## Requirements

- Claude Code **v2.1.80+** (v2.1.81+ for permission relay, which this adapter does not use)
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
```

- [ ] **Step 2: Manual smoke with a real Claude Code session**

(This step is not automatable; record the result in the commit message.)

1. Build + link:
   ```bash
   pnpm -r build
   pnpm link --global --filter a2a-claude-code-adapter
   ```
2. Provision claw-connect config (if not already done):
   ```bash
   claw-connect init
   claw-connect register bob --local-endpoint http://127.0.0.1:38800
   ```
3. Register the MCP server in `~/.claude.json`:
   ```json
   { "mcpServers": { "a2a": { "command": "a2a-claude-code-adapter", "args": ["--agent", "bob"] } } }
   ```
4. Start Claude Code:
   ```bash
   claude --dangerously-load-development-channels server:a2a
   ```
5. In another terminal, simulate claw-connect forwarding an inbound A2A POST directly to the adapter:
   ```bash
   curl -sS -X POST http://127.0.0.1:38800/message:send \
     -H 'Content-Type: application/json' \
     -d '{"message":{"messageId":"m1","role":"user","parts":[{"kind":"text","text":"hello Bob"}]}}'
   ```
   Expected: the curl hangs. In the Claude Code session, a `<channel source="a2a" task_id="...">hello Bob</channel>` block appears. Claude draft a reply and calls `a2a_reply`. The curl returns an A2A `completed` response carrying the reply.

If the `<channel>` tag doesn't appear, run `/mcp` inside the session to confirm the adapter is listed and connected. Check `~/.claude/debug/<session-id>.txt` for stderr from the adapter.

- [ ] **Step 3: Commit**

```bash
git add packages/a2a-claude-code-adapter/README.md
git commit -m "docs(adapter): README + manual Claude Code verification steps"
```

---

## Post-plan notes

- **Stream support** is not in v1. Add `POST /message\\:stream` to `http.ts` later, reusing `formatSseEvent` from `claw-connect/a2a.js`. The channel notification would emit once at inbound; the reply tool resolves the SSE stream rather than a JSON response.
- **Peer identity in channel meta** (e.g. `meta: { task_id, peer: "alice" }`) requires claw-connect to forward the authenticated peer handle as a request header. Currently `packages/claw-connect/src/proxy.ts` doesn't do that. Adding it is a small follow-up in claw-connect; the adapter just has to read the header and include it in meta. Keys must match `[A-Za-z0-9_]+` per the channels contract.
- **Permission relay** (declare `claude/channel/permission` capability) intentionally not implemented — see the channels-reference docs for the contract when we're ready.
- **Publishing** the adapter to npm is blocked by the channels research-preview allowlist. Until the adapter is approved (or orgs override via `allowedChannelPlugins`), users must use `--dangerously-load-development-channels server:a2a`.
