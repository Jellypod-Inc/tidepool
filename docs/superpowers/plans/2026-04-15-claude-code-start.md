# `tidepool claude-code:start` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-command setup that runs Claude Code with A2A wiring. `tidepool claude-code:start` does init/register/mcp-json/daemonize/exec-claude. `--debug` runs serve in the foreground and prints second-terminal instructions. `tidepool stop` and extended `status` manage the daemon.

**Architecture:** Thin orchestrator (`cli/claude-code-start.ts`) composed from focused helpers (`name-resolver`, `free-port`, `mcp-json`, `serve-daemon`). Daemon uses `child_process.spawn` with `detached: true` + PID file + append-mode log. Re-entry reads `.mcp.json` for the agent name.

**Tech Stack:** Node 20+, TypeScript, Commander, `unique-names-generator`, node `child_process`/`net`, vitest.

**Spec:** `docs/superpowers/specs/2026-04-15-claude-code-start-design.md`

---

## File Structure

**Create (source):**
- `packages/tidepool/src/cli/name-resolver.ts`
- `packages/tidepool/src/cli/free-port.ts`
- `packages/tidepool/src/cli/mcp-json.ts`
- `packages/tidepool/src/cli/serve-daemon.ts`
- `packages/tidepool/src/cli/stop.ts`
- `packages/tidepool/src/cli/claude-code-start.ts`

**Create (tests):**
- `packages/tidepool/test/cli/name-resolver.test.ts`
- `packages/tidepool/test/cli/free-port.test.ts`
- `packages/tidepool/test/cli/mcp-json.test.ts`
- `packages/tidepool/test/cli/serve-daemon.test.ts`
- `packages/tidepool/test/cli/stop.test.ts`
- `packages/tidepool/test/cli/claude-code-start-e2e.test.ts`

**Modify:**
- `packages/tidepool/package.json` — add `unique-names-generator` dep.
- `packages/tidepool/src/bin/cli.ts` — wire up new commands + extended help text.
- `packages/tidepool/src/cli/status.ts` — append daemon state to output.
- `packages/tidepool/test/cli/status.test.ts` — cover daemon-up and daemon-down cases.
- `packages/a2a-claude-code-adapter/README.md` — lead with `claude-code:start`, demote manual flow.

**Dependency graph between tasks:**
```
T1 name-resolver  ──┐
T2 free-port      ──┤
T3 mcp-json       ──┼──→ T7 claude-code-start
T4 serve-daemon   ──┤            │
T5 stop           ──┘            │
T6 status extend     ────────────┤
                                 │
                                 ├──→ T8 bin wiring
                                 ├──→ T9 README update
                                 └──→ T10 final validation
```

T1–T6 are independent of each other — could even parallelize.

---

## Task 1: Agent name resolver

**Files:**
- Create: `packages/tidepool/src/cli/name-resolver.ts`
- Test: `packages/tidepool/test/cli/name-resolver.test.ts`
- Modify: `packages/tidepool/package.json` (add `unique-names-generator`)

- [ ] **Step 1: Add dependency**

```bash
cd /Users/piersonmarks/src/tries/2026-04-13-tidepool
pnpm --filter tidepool add unique-names-generator@^4
```

Expected: package.json updated, lockfile regenerated.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/tidepool/test/cli/name-resolver.test.ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveAgentName } from "../../src/cli/name-resolver.js";
import type { ServerConfig } from "../../src/types.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-name-"));
}

function makeServerConfig(agentNames: string[] = []): ServerConfig {
  const agents: ServerConfig["agents"] = {};
  for (const n of agentNames) {
    agents[n] = { localEndpoint: "http://127.0.0.1:1", rateLimit: "50/hour", description: "", timeoutSeconds: 30 };
  }
  return {
    server: { port: 9900, host: "0.0.0.0", localPort: 9901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
    agents,
    connectionRequests: { mode: "deny" },
    discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    validation: { mode: "warn" },
  };
}

describe("resolveAgentName", () => {
  it("uses explicit arg when provided", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(),
      explicit: "alice-dev",
    });
    expect(result).toBe("alice-dev");
  });

  it("rejects invalid explicit name", async () => {
    const cwd = tmp();
    await expect(
      resolveAgentName({ cwd, serverConfig: makeServerConfig(), explicit: "Alice!" }),
    ).rejects.toThrow(/lowercase/i);
  });

  it("reuses name from existing .mcp.json's a2a entry", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "donkey"] },
          other: { command: "foo", args: [] },
        },
      }),
    );
    const result = await resolveAgentName({ cwd, serverConfig: makeServerConfig() });
    expect(result).toBe("donkey");
  });

  it("generates a name when no arg and no .mcp.json", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(),
      rng: () => "zebra", // injected for determinism
    });
    expect(result).toBe("zebra");
  });

  it("re-rolls on collision with existing agent", async () => {
    const cwd = tmp();
    const names = ["donkey", "donkey", "zebra"];
    let i = 0;
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(["donkey"]),
      rng: () => names[i++]!,
    });
    expect(result).toBe("zebra");
  });

  it("falls back to <name>-<hex6> after 5 collisions", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(["donkey"]),
      rng: () => "donkey",
    });
    expect(result).toMatch(/^donkey-[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter tidepool test -- cli/name-resolver`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

```typescript
// packages/tidepool/src/cli/name-resolver.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { uniqueNamesGenerator, animals } from "unique-names-generator";
import type { ServerConfig } from "../types.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_RETRIES = 5;

export interface ResolveAgentNameOpts {
  cwd: string;
  serverConfig: ServerConfig;
  explicit?: string;
  rng?: () => string; // injected for tests
}

export async function resolveAgentName(opts: ResolveAgentNameOpts): Promise<string> {
  if (opts.explicit !== undefined) {
    if (!NAME_PATTERN.test(opts.explicit)) {
      throw new Error(
        `Agent name "${opts.explicit}" is not valid. Use lowercase letters, digits, and hyphens; start with a letter.`,
      );
    }
    return opts.explicit;
  }

  const fromMcp = readAgentFromMcpJson(path.join(opts.cwd, ".mcp.json"));
  if (fromMcp !== null) return fromMcp;

  const rng = opts.rng ?? (() => uniqueNamesGenerator({ dictionaries: [animals] }));
  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = rng();
    if (!(candidate in opts.serverConfig.agents)) return candidate;
  }

  // 5 straight collisions; fall back to a suffixed form based on the last candidate.
  const last = rng();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${last}-${suffix}`;
}

function readAgentFromMcpJson(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  const a2a = (parsed as { mcpServers?: { a2a?: { args?: unknown[] } } })?.mcpServers?.a2a;
  if (!a2a || !Array.isArray(a2a.args)) return null;
  const idx = a2a.args.indexOf("--agent");
  if (idx < 0 || idx + 1 >= a2a.args.length) return null;
  const next = a2a.args[idx + 1];
  return typeof next === "string" ? next : null;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter tidepool test -- cli/name-resolver`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/piersonmarks/src/tries/2026-04-13-tidepool
git add packages/tidepool/package.json packages/tidepool/src/cli/name-resolver.ts packages/tidepool/test/cli/name-resolver.test.ts pnpm-lock.yaml && git commit -m "feat(tidepool): agent name resolver with animal fallback"
```

---

## Task 2: Free loopback port picker

**Files:**
- Create: `packages/tidepool/src/cli/free-port.ts`
- Test: `packages/tidepool/test/cli/free-port.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/tidepool/test/cli/free-port.test.ts
import { describe, it, expect } from "vitest";
import net from "net";
import { pickFreeLoopbackPort } from "../../src/cli/free-port.js";

describe("pickFreeLoopbackPort", () => {
  it("returns a port in the ephemeral range", async () => {
    const port = await pickFreeLoopbackPort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that can actually be bound", async () => {
    const port = await pickFreeLoopbackPort();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `pnpm --filter tidepool test -- cli/free-port`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// packages/tidepool/src/cli/free-port.ts
import net from "net";

export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("unexpected address shape"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter tidepool test -- cli/free-port`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tidepool/src/cli/free-port.ts packages/tidepool/test/cli/free-port.test.ts && git commit -m "feat(tidepool): pick free loopback port helper"
```

---

## Task 3: `.mcp.json` merger

**Files:**
- Create: `packages/tidepool/src/cli/mcp-json.ts`
- Test: `packages/tidepool/test/cli/mcp-json.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/tidepool/test/cli/mcp-json.test.ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ensureMcpJsonEntry } from "../../src/cli/mcp-json.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-"));
}

describe("ensureMcpJsonEntry", () => {
  it("creates .mcp.json when absent", async () => {
    const cwd = tmp();
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "created", previousAgent: null });

    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.a2a).toEqual({
      command: "a2a-claude-code-adapter",
      args: ["--agent", "donkey"],
    });
  });

  it("preserves other mcpServers when merging", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "foo", args: ["bar"] },
        },
      }),
    );
    await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.other).toEqual({ command: "foo", args: ["bar"] });
    expect(content.mcpServers.a2a).toEqual({
      command: "a2a-claude-code-adapter",
      args: ["--agent", "donkey"],
    });
  });

  it("overwrites args when existing a2a points at a different agent", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "zebra"] },
        },
      }),
    );
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "updated", previousAgent: "zebra" });
    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.a2a.args).toEqual(["--agent", "donkey"]);
  });

  it("no-ops when args already match", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "donkey"] },
        },
      }),
    );
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "unchanged", previousAgent: "donkey" });
  });

  it("refuses to parse invalid JSON", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ not json");
    await expect(ensureMcpJsonEntry({ cwd, agentName: "donkey" })).rejects.toThrow(/\.mcp\.json/);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm --filter tidepool test -- cli/mcp-json`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// packages/tidepool/src/cli/mcp-json.ts
import fs from "fs";
import path from "path";

export interface EnsureMcpJsonOpts {
  cwd: string;
  agentName: string;
}

export type EnsureMcpJsonResult =
  | { action: "created"; previousAgent: null }
  | { action: "updated"; previousAgent: string | null }
  | { action: "unchanged"; previousAgent: string };

const ADAPTER_COMMAND = "a2a-claude-code-adapter";

export async function ensureMcpJsonEntry(
  opts: EnsureMcpJsonOpts,
): Promise<EnsureMcpJsonResult> {
  const filePath = path.join(opts.cwd, ".mcp.json");
  const desiredArgs = ["--agent", opts.agentName];

  if (!fs.existsSync(filePath)) {
    const fresh = {
      mcpServers: {
        a2a: { command: ADAPTER_COMMAND, args: desiredArgs },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + "\n");
    return { action: "created", previousAgent: null };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`.mcp.json can't be parsed: ${msg}. Fix or remove it and rerun.`);
  }

  const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = mcpServers.a2a as { command?: string; args?: unknown[] } | undefined;
  const previousAgent = extractAgent(existing?.args);

  const alreadyCorrect =
    existing?.command === ADAPTER_COMMAND &&
    Array.isArray(existing?.args) &&
    existing!.args!.length === desiredArgs.length &&
    existing!.args!.every((v, i) => v === desiredArgs[i]);

  if (alreadyCorrect && previousAgent !== null) {
    return { action: "unchanged", previousAgent };
  }

  mcpServers.a2a = { command: ADAPTER_COMMAND, args: desiredArgs };
  parsed.mcpServers = mcpServers;
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n");

  return { action: "updated", previousAgent };
}

function extractAgent(args: unknown[] | undefined): string | null {
  if (!Array.isArray(args)) return null;
  const idx = args.indexOf("--agent");
  if (idx < 0 || idx + 1 >= args.length) return null;
  const v = args[idx + 1];
  return typeof v === "string" ? v : null;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter tidepool test -- cli/mcp-json`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tidepool/src/cli/mcp-json.ts packages/tidepool/test/cli/mcp-json.test.ts && git commit -m "feat(tidepool): merge .mcp.json a2a entry"
```

---

## Task 4: Serve daemon supervisor

**Files:**
- Create: `packages/tidepool/src/cli/serve-daemon.ts`
- Test: `packages/tidepool/test/cli/serve-daemon.test.ts`

Design notes:
- `isServeRunning(configDir, opts?)` checks PID file liveness + HTTP readiness probe. Mockable via an optional `probe` function for unit tests.
- `spawnServeDaemon(configDir, opts?)` spawns detached, writes PID + log, returns once ready. `spawner` option defaults to Node's `spawn` but is injectable.
- Both functions read `server.toml` via existing `loadServerConfig` to get `localPort`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/tidepool/test/cli/serve-daemon.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { runInit } from "../../src/cli/init.js";
import {
  isServeRunning,
  spawnServeDaemon,
  PID_FILENAME,
} from "../../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-daemon-"));
}

async function startStubServer(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) s.close();
  servers.length = 0;
});

describe("isServeRunning", () => {
  it("returns false when PID file is absent", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await isServeRunning({ configDir: dir });
    expect(result.running).toBe(false);
    expect(result.reason).toBe("no-pid-file");
  });

  it("cleans up stale PID file and returns false", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    // PID that is extremely unlikely to exist
    fs.writeFileSync(path.join(dir, PID_FILENAME), "999999");
    const result = await isServeRunning({ configDir: dir });
    expect(result.running).toBe(false);
    expect(result.reason).toBe("stale-pid-file");
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });

  it("returns true when PID alive and port responds", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    // Write our own PID — guaranteed alive
    fs.writeFileSync(path.join(dir, PID_FILENAME), String(process.pid));

    // Start a stub on the configured local port (read from server.toml default 9901)
    // Override the default port to avoid collisions
    const localPort = 51234;
    const stub = await startStubServer(localPort);
    servers.push(stub);

    const result = await isServeRunning({
      configDir: dir,
      localPortOverride: localPort,
    });
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
  });
});

describe("spawnServeDaemon", () => {
  it("invokes the injected spawner with detached + stdio", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    let capturedArgs: string[] | null = null;
    let capturedOptions: Record<string, unknown> | null = null;

    const fakeProcess = {
      pid: 424242,
      unref: () => {},
      once: () => fakeProcess,
      kill: () => true,
    };

    const port = 51235;
    const stub = await startStubServer(port);
    servers.push(stub);

    await spawnServeDaemon({
      configDir: dir,
      localPortOverride: port,
      readinessTimeoutMs: 500,
      spawner: (_cmd, args, options) => {
        capturedArgs = args as string[];
        capturedOptions = options as Record<string, unknown>;
        return fakeProcess as never;
      },
    });

    expect(capturedArgs).toEqual(["serve"]);
    expect(capturedOptions?.detached).toBe(true);
    const pidContent = fs.readFileSync(path.join(dir, PID_FILENAME), "utf-8");
    expect(pidContent.trim()).toBe("424242");
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(true);
  });

  it("errors out if port never becomes ready", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    let killed = false;
    const fakeProcess = {
      pid: 424243,
      unref: () => {},
      once: () => fakeProcess,
      kill: () => {
        killed = true;
        return true;
      },
    };

    await expect(
      spawnServeDaemon({
        configDir: dir,
        localPortOverride: 1, // nothing listens; probe will always fail
        readinessTimeoutMs: 150,
        spawner: () => fakeProcess as never,
      }),
    ).rejects.toThrow(/not become ready/i);

    expect(killed).toBe(true);
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `pnpm --filter tidepool test -- cli/serve-daemon`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// packages/tidepool/src/cli/serve-daemon.ts
import fs from "fs";
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { loadServerConfig } from "../config.js";

export const PID_FILENAME = "serve.pid";
export const LOGS_DIRNAME = "logs";

type SpawnFn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface IsServeRunningOpts {
  configDir: string;
  localPortOverride?: number;
  probe?: (url: string) => Promise<boolean>;
}

export type IsServeRunningResult =
  | { running: false; reason: "no-pid-file" }
  | { running: false; reason: "stale-pid-file" }
  | { running: false; reason: "port-not-responding"; pid: number }
  | { running: true; pid: number };

export async function isServeRunning(
  opts: IsServeRunningOpts,
): Promise<IsServeRunningResult> {
  const pidPath = path.join(opts.configDir, PID_FILENAME);
  if (!fs.existsSync(pidPath)) {
    return { running: false, reason: "no-pid-file" };
  }

  const raw = fs.readFileSync(pidPath, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    fs.unlinkSync(pidPath);
    return { running: false, reason: "stale-pid-file" };
  }

  if (!isProcessAlive(pid)) {
    fs.unlinkSync(pidPath);
    return { running: false, reason: "stale-pid-file" };
  }

  const localPort = opts.localPortOverride ?? readLocalPort(opts.configDir);
  const url = `http://127.0.0.1:${localPort}/.well-known/agent-card.json`;
  const probe = opts.probe ?? defaultProbe;
  const reachable = await probe(url);
  if (!reachable) {
    return { running: false, reason: "port-not-responding", pid };
  }
  return { running: true, pid };
}

export interface SpawnServeDaemonOpts {
  configDir: string;
  localPortOverride?: number;
  readinessTimeoutMs?: number;
  spawner?: SpawnFn;
  probe?: (url: string) => Promise<boolean>;
  now?: () => Date;
}

export async function spawnServeDaemon(opts: SpawnServeDaemonOpts): Promise<{ pid: number; logPath: string }> {
  const logsDir = path.join(opts.configDir, LOGS_DIRNAME);
  fs.mkdirSync(logsDir, { recursive: true });

  const date = (opts.now ?? (() => new Date()))();
  const ymd = toYmdUtc(date);
  const logPath = path.join(logsDir, `serve-${ymd}.log`);
  const logFd = fs.openSync(logPath, "a");

  const spawner = opts.spawner ?? nodeSpawn;
  const child = spawner("tidepool", ["serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, TIDEPOOL_HOME: opts.configDir },
  });
  fs.closeSync(logFd);

  if (child.pid === undefined) {
    throw new Error("spawn returned no PID");
  }

  const pidPath = path.join(opts.configDir, PID_FILENAME);
  fs.writeFileSync(pidPath, String(child.pid));

  child.unref();

  const localPort = opts.localPortOverride ?? readLocalPort(opts.configDir);
  const url = `http://127.0.0.1:${localPort}/.well-known/agent-card.json`;
  const probe = opts.probe ?? defaultProbe;
  const timeoutMs = opts.readinessTimeoutMs ?? 3000;

  const ready = await waitForReady(url, timeoutMs, probe);
  if (!ready) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    throw new Error(
      `Tidepool did not become ready within ${timeoutMs}ms. Check logs at ${logPath}, or rerun with --debug to see output.`,
    );
  }

  return { pid: child.pid, logPath };
}

function readLocalPort(configDir: string): number {
  const cfg = loadServerConfig(path.join(configDir, "server.toml"));
  return cfg.server.localPort;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  probe: (url: string) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function toYmdUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter tidepool test -- cli/serve-daemon`
Expected: PASS (5 tests). Some may take up to 500ms due to timeouts.

- [ ] **Step 5: Commit**

```bash
git add packages/tidepool/src/cli/serve-daemon.ts packages/tidepool/test/cli/serve-daemon.test.ts && git commit -m "feat(tidepool): serve daemon supervisor (PID file + log)"
```

---

## Task 5: `stop` command

**Files:**
- Create: `packages/tidepool/src/cli/stop.ts`
- Test: `packages/tidepool/test/cli/stop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/tidepool/test/cli/stop.test.ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { runStop } from "../../src/cli/stop.js";
import { PID_FILENAME } from "../../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-stop-"));
}

describe("runStop", () => {
  it("reports not-running when PID file absent", async () => {
    const dir = tmp();
    const result = await runStop({ configDir: dir });
    expect(result).toEqual({ action: "not-running" });
  });

  it("cleans up stale PID file and reports not-running", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, PID_FILENAME), "999999");
    const result = await runStop({ configDir: dir });
    expect(result).toEqual({ action: "not-running" });
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });

  it("sends SIGTERM to a live process and removes PID file", async () => {
    const dir = tmp();
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(dir, PID_FILENAME), String(child.pid));

    const result = await runStop({ configDir: dir, gracePeriodMs: 1000 });
    expect(result.action).toBe("stopped");
    expect(result.pid).toBe(child.pid);
    expect(result.forced).toBe(false);
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `pnpm --filter tidepool test -- cli/stop`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// packages/tidepool/src/cli/stop.ts
import fs from "fs";
import path from "path";
import { PID_FILENAME } from "./serve-daemon.js";

export interface RunStopOpts {
  configDir: string;
  gracePeriodMs?: number;
}

export type RunStopResult =
  | { action: "not-running" }
  | { action: "stopped"; pid: number; forced: boolean };

export async function runStop(opts: RunStopOpts): Promise<RunStopResult> {
  const pidPath = path.join(opts.configDir, PID_FILENAME);
  if (!fs.existsSync(pidPath)) {
    return { action: "not-running" };
  }

  const raw = fs.readFileSync(pidPath, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0 || !isAlive(pid)) {
    fs.unlinkSync(pidPath);
    return { action: "not-running" };
  }

  process.kill(pid, "SIGTERM");
  const grace = opts.gracePeriodMs ?? 2000;
  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      fs.unlinkSync(pidPath);
      return { action: "stopped", pid, forced: false };
    }
    await sleep(50);
  }

  process.kill(pid, "SIGKILL");
  // give the OS a moment to reap
  await sleep(50);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  return { action: "stopped", pid, forced: true };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter tidepool test -- cli/stop`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tidepool/src/cli/stop.ts packages/tidepool/test/cli/stop.test.ts && git commit -m "feat(tidepool): add tidepool stop command helper"
```

---

## Task 6: Extend `status` with daemon state

**Files:**
- Modify: `packages/tidepool/src/cli/status.ts`
- Modify: `packages/tidepool/test/cli-status.test.ts` (or add `test/cli/status.test.ts` if separate)

- [ ] **Step 1: Read the current status module**

Before changing anything, open `packages/tidepool/src/cli/status.ts` and observe the current output shape. The function `runStatus` is presumably returning a formatted string.

- [ ] **Step 2: Add a failing test that expects daemon info**

If existing tests live at `packages/tidepool/test/cli-status.test.ts`, add a new `describe` block to that file:

```typescript
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../src/cli/init.js";
import { runStatus } from "../src/cli/status.js";
import { PID_FILENAME } from "../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-daemon-"));
}

describe("runStatus — daemon section", () => {
  it("shows 'not running' when no PID file", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const out = await runStatus({ configDir: dir });
    expect(out).toMatch(/Daemon:\s+not running/i);
  });

  it("shows 'running' with PID when live", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    fs.writeFileSync(path.join(dir, PID_FILENAME), String(process.pid));
    const out = await runStatus({ configDir: dir });
    expect(out).toMatch(new RegExp(`Daemon:\\s+running\\s+\\(PID\\s+${process.pid}`));
  });
});
```

- [ ] **Step 3: Run test to verify fail**

Run: `pnpm --filter tidepool test -- cli-status`
Expected: FAIL — daemon section missing from output.

- [ ] **Step 4: Extend `runStatus`**

Open `packages/tidepool/src/cli/status.ts`. Add an import:

```typescript
import { isServeRunning } from "./serve-daemon.js";
```

Inside `runStatus`, after the existing config summary is built, append:

```typescript
  const daemon = await isServeRunning({ configDir: opts.configDir });
  const daemonLine =
    daemon.running
      ? `Daemon: running (PID ${daemon.pid})`
      : `Daemon: not running`;
  lines.push("", daemonLine);
```

Adjust variable names to match whatever the existing function uses (e.g., if the output is built as a single string via `out.join("\n")` or a `lines` array). Keep the section appended to the end.

- [ ] **Step 5: Run test to verify pass**

Run: `pnpm --filter tidepool test -- cli-status`
Expected: PASS. The original status tests must also still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/tidepool/src/cli/status.ts packages/tidepool/test/cli-status.test.ts && git commit -m "feat(tidepool): status shows daemon state"
```

---

## Task 7: `claude-code-start` orchestrator

**Files:**
- Create: `packages/tidepool/src/cli/claude-code-start.ts`
- Test: `packages/tidepool/test/cli/claude-code-start-e2e.test.ts`

The orchestrator composes all prior helpers. It takes DI for the spawner and for `exec`-ing claude so the test can assert behavior without actually launching Claude Code.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/tidepool/test/cli/claude-code-start-e2e.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { runClaudeCodeStart } from "../../src/cli/claude-code-start.js";
import { loadServerConfig } from "../../src/config.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startStub(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) s.close();
  servers.length = 0;
});

describe("runClaudeCodeStart — fresh repo (default)", () => {
  it("initializes, registers an agent, writes .mcp.json, starts daemon, execs claude", async () => {
    const configDir = tmp("cc-start-home-");
    const cwd = tmp("cc-start-cwd-");

    // Pre-pick a free local port to avoid collisions across tests
    const LOCAL_PORT = 52100;
    // We'll start a stub that responds to the readiness probe so the daemon
    // check passes without actually spawning tidepool serve.
    const stub = await startStub(LOCAL_PORT);
    servers.push(stub);

    const execCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];

    const fakeProcess = { pid: 99999, unref: () => {}, once: () => fakeProcess, kill: () => true };

    await runClaudeCodeStart({
      configDir,
      cwd,
      explicitAgent: "donkey",
      debug: false,
      localPortOverride: LOCAL_PORT,
      spawner: () => fakeProcess as never,
      readinessTimeoutMs: 500,
      claudeExecutor: (cmd, args, options) => {
        execCalls.push({ cmd, args, cwd: options.cwd ?? "" });
      },
      claudeOnPath: () => true,
      rng: () => "donkey",
    });

    // agent registered
    const cfg = loadServerConfig(path.join(configDir, "server.toml"));
    expect(cfg.agents.donkey).toBeDefined();

    // .mcp.json exists with --agent donkey
    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.a2a.args).toEqual(["--agent", "donkey"]);

    // PID file written
    expect(fs.existsSync(path.join(configDir, "serve.pid"))).toBe(true);

    // claude was execed with correct args from the project cwd
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe("claude");
    expect(execCalls[0].args).toEqual([
      "--dangerously-load-development-channels",
      "server:a2a",
    ]);
    expect(execCalls[0].cwd).toBe(cwd);
  });
});

describe("runClaudeCodeStart — re-entry", () => {
  it("reuses existing agent name and skips registration", async () => {
    const configDir = tmp("cc-restart-home-");
    const cwd = tmp("cc-restart-cwd-");
    const LOCAL_PORT = 52101;
    const stub = await startStub(LOCAL_PORT);
    servers.push(stub);

    const fakeProcess = { pid: 99998, unref: () => {}, once: () => fakeProcess, kill: () => true };
    const execCalls: Array<{ args: string[] }> = [];
    const run = () =>
      runClaudeCodeStart({
        configDir,
        cwd,
        debug: false,
        localPortOverride: LOCAL_PORT,
        spawner: () => fakeProcess as never,
        readinessTimeoutMs: 500,
        claudeExecutor: (_cmd, args) => {
          execCalls.push({ args });
        },
        claudeOnPath: () => true,
        rng: () => "donkey",
      });

    await run();
    const firstCfg = loadServerConfig(path.join(configDir, "server.toml"));
    const firstPort = firstCfg.agents.donkey.localEndpoint;

    await run();
    const secondCfg = loadServerConfig(path.join(configDir, "server.toml"));
    expect(Object.keys(secondCfg.agents)).toEqual(["donkey"]);
    expect(secondCfg.agents.donkey.localEndpoint).toBe(firstPort);
    expect(execCalls).toHaveLength(2);
  });
});

describe("runClaudeCodeStart — --debug", () => {
  it("does not exec claude and does not create PID file", async () => {
    const configDir = tmp("cc-debug-home-");
    const cwd = tmp("cc-debug-cwd-");

    const serveInvocations: Array<unknown> = [];

    await runClaudeCodeStart({
      configDir,
      cwd,
      explicitAgent: "zebra",
      debug: true,
      claudeExecutor: () => {
        throw new Error("claude should not be execed in --debug mode");
      },
      claudeOnPath: () => true,
      rng: () => "zebra",
      debugServeRunner: async () => {
        serveInvocations.push("ran");
        return;
      },
    });

    expect(fs.existsSync(path.join(configDir, "serve.pid"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(serveInvocations).toEqual(["ran"]);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm --filter tidepool test -- claude-code-start`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the orchestrator**

```typescript
// packages/tidepool/src/cli/claude-code-start.ts
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { runInit } from "./init.js";
import { runRegister } from "./register.js";
import { loadServerConfig } from "../config.js";
import { resolveAgentName } from "./name-resolver.js";
import { pickFreeLoopbackPort } from "./free-port.js";
import { ensureMcpJsonEntry } from "./mcp-json.js";
import {
  isServeRunning,
  spawnServeDaemon,
} from "./serve-daemon.js";

type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
type ClaudeExec = (cmd: string, args: string[], options: { cwd?: string; stdio?: "inherit" }) => void;

export interface RunClaudeCodeStartOpts {
  configDir: string;
  cwd: string;
  explicitAgent?: string;
  debug: boolean;

  // injection points (tests only)
  localPortOverride?: number;
  spawner?: SpawnFn;
  readinessTimeoutMs?: number;
  claudeExecutor?: ClaudeExec;
  claudeOnPath?: () => boolean;
  rng?: () => string;
  debugServeRunner?: (configDir: string) => Promise<void>;
}

export async function runClaudeCodeStart(opts: RunClaudeCodeStartOpts): Promise<void> {
  // 1. init (idempotent)
  await runInit({ configDir: opts.configDir });

  // 2. resolve name
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const agentName = await resolveAgentName({
    cwd: opts.cwd,
    serverConfig: cfg,
    explicit: opts.explicitAgent,
    rng: opts.rng,
  });

  // 3. register if needed
  const cfg2 = loadServerConfig(path.join(opts.configDir, "server.toml"));
  if (!(agentName in cfg2.agents)) {
    const port = await pickFreeLoopbackPort();
    await runRegister({
      configDir: opts.configDir,
      name: agentName,
      localEndpoint: `http://127.0.0.1:${port}`,
    });
  }

  // 4. .mcp.json
  await ensureMcpJsonEntry({ cwd: opts.cwd, agentName });

  if (opts.debug) {
    // 5a. foreground serve (no daemon, no PID)
    const runner = opts.debugServeRunner ?? defaultDebugServeRunner;
    await runner(opts.configDir);
    return;
  }

  // 5b. ensure daemon
  const running = await isServeRunning({
    configDir: opts.configDir,
    localPortOverride: opts.localPortOverride,
  });
  if (!running.running) {
    await spawnServeDaemon({
      configDir: opts.configDir,
      spawner: opts.spawner,
      localPortOverride: opts.localPortOverride,
      readinessTimeoutMs: opts.readinessTimeoutMs,
    });
  }

  // 6. exec claude
  const onPath = (opts.claudeOnPath ?? defaultClaudeOnPath)();
  if (onPath) {
    const exec = opts.claudeExecutor ?? defaultClaudeExecutor;
    exec(
      "claude",
      ["--dangerously-load-development-channels", "server:a2a"],
      { cwd: opts.cwd, stdio: "inherit" },
    );
  } else {
    process.stdout.write(
      `\nclaude is not on your PATH.\nRun this in a fresh terminal:\n  cd ${opts.cwd} && claude --dangerously-load-development-channels server:a2a\n`,
    );
  }
}

async function defaultDebugServeRunner(configDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn("tidepool", ["serve"], {
      stdio: "inherit",
      env: { ...process.env, TIDEPOOL_HOME: configDir },
    });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

function defaultClaudeOnPath(): boolean {
  const PATH = process.env.PATH ?? "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const p = path.join(dir, "claude");
      // We only care if it exists; X_OK check not portable on all fs types
      require("fs").accessSync(p);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

const defaultClaudeExecutor: ClaudeExec = (cmd, args, options) => {
  nodeSpawn(cmd, args, { stdio: options.stdio ?? "inherit", cwd: options.cwd });
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter tidepool test -- claude-code-start`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tidepool/src/cli/claude-code-start.ts packages/tidepool/test/cli/claude-code-start-e2e.test.ts && git commit -m "feat(tidepool): claude-code:start orchestrator"
```

---

## Task 8: Wire commands into the CLI

**Files:**
- Modify: `packages/tidepool/src/bin/cli.ts`

- [ ] **Step 1: Register the new commands**

In `packages/tidepool/src/bin/cli.ts`, add three imports near the top next to the other `runX` imports:

```typescript
import { runClaudeCodeStart } from "../cli/claude-code-start.js";
import { runStop } from "../cli/stop.js";
```

Then, BEFORE the `program.parseAsync(process.argv)` call at the bottom, register the commands:

```typescript
program
  .command("claude-code:start [agent]")
  .description("Start a Claude Code session wired up via A2A")
  .option("--debug", "Run tidepool serve in the foreground; don't exec claude")
  .action(async (agent: string | undefined, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    await runClaudeCodeStart({
      configDir,
      cwd: process.cwd(),
      explicitAgent: agent,
      debug: !!cmdOpts.debug,
    });
  });

program
  .command("stop")
  .description("Stop the background tidepool daemon")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const result = await runStop({ configDir });
    if (result.action === "not-running") {
      ok("Tidepool is not running.");
    } else if (result.forced) {
      ok(`Force-killed (SIGKILL) PID ${result.pid}.`);
    } else {
      ok(`Stopped (was PID ${result.pid}).`);
    }
  });
```

Also update the `addHelpText` block near the top of the file to include the new examples:

```typescript
program.addHelpText(
  "after",
  `\nExamples:\n` +
    `  $ tidepool claude-code:start\n` +
    `  $ tidepool claude-code:start my-agent --debug\n` +
    `  $ tidepool stop\n` +
    `  $ tidepool init\n` +
    `  $ tidepool register alice-dev --local-endpoint http://127.0.0.1:28800\n` +
    `  $ tidepool whoami\n` +
    `  $ tidepool friend add bob sha256:...\n` +
    `  $ tidepool remote add bobs-rust https://peer:29900 rust-expert sha256:...\n` +
    `  $ tidepool serve\n`,
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter tidepool typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke the new commands**

```bash
pnpm --filter tidepool build
export TIDEPOOL_HOME=$(mktemp -d)
node packages/tidepool/dist/bin/cli.js --help | grep claude-code
# Expected: shows the new line including claude-code:start.
node packages/tidepool/dist/bin/cli.js stop
# Expected: "Tidepool is not running."
```

- [ ] **Step 4: Commit**

```bash
git add packages/tidepool/src/bin/cli.ts && git commit -m "feat(tidepool): wire claude-code:start and stop into CLI"
```

---

## Task 9: Update adapter README to lead with `claude-code:start`

**Files:**
- Modify: `packages/a2a-claude-code-adapter/README.md`

- [ ] **Step 1: Rewrite the main walkthrough to use the new command**

Open `packages/a2a-claude-code-adapter/README.md`. Replace Steps 2 through 5 of the current "what you'll have at the end" walkthrough with a single new section titled `## Step 2 — Start a Claude Code session wired up for A2A`. Content to use:

```markdown
## Step 2 — Start a Claude Code session wired up for A2A

From any project directory:

```bash
tidepool claude-code:start
```

What this does, in order:

1. Sets up a Tidepool "home" at `~/.config/tidepool` (first run only).
2. Generates a friendly name for this agent (e.g. `donkey`) if you don't provide one.
3. Picks a free local port and registers the agent.
4. Writes or merges `.mcp.json` in the current directory so Claude Code loads the adapter.
5. Starts `tidepool serve` in the background.
6. Launches Claude Code with the correct flag.

Pass a name if you want a specific one:

```bash
tidepool claude-code:start bob
```

Run it again in the same project directory — it's idempotent. It reads the existing `.mcp.json`, reuses the name and port, and drops you straight into Claude Code.

### Extra commands

| | |
|---|---|
| `tidepool stop` | Stop the background server |
| `tidepool status` | See if the server is running and where logs are |
| `tidepool claude-code:start --debug` | Run the server in the foreground and print the `cd <dir> && claude …` command to paste into a second terminal |
```

Keep Step 1 (install) and Step 3 onward (what to do once inside Claude Code; troubleshooting; flags; scope) but renumber. Leave the "Sending to someone else's machine" and "Flags" and "Scope" sections unchanged.

Also, move the old 6-step manual flow (init/register/serve/claude) under a collapsed `<details>` tag at the end titled "Manual setup (under the hood)" so it's still available for curious users.

- [ ] **Step 2: Commit**

```bash
git add packages/a2a-claude-code-adapter/README.md && git commit -m "docs(a2a-adapter): README leads with claude-code:start"
```

---

## Task 10: Final validation

- [ ] **Step 1: Typecheck everything**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 2: Build everything**

Run: `pnpm -r build`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm -r test`
Expected: PASS. Count should be the prior 239 plus the new tests from Tasks 1–7 (approximately 22 new tests — exact count depends on how many the reviewer adds). All green.

- [ ] **Step 4: Real-world smoke**

```bash
export TIDEPOOL_HOME=$(mktemp -d)
cd /tmp && mkdir cc-smoke && cd cc-smoke
node /Users/piersonmarks/src/tries/2026-04-13-tidepool/packages/tidepool/dist/bin/cli.js claude-code:start smoke-agent --debug &
SMOKE_PID=$!
sleep 2
# Verify .mcp.json written
cat .mcp.json
# Kill the foreground server
kill $SMOKE_PID 2>/dev/null
# Confirm home contents
ls "$TIDEPOOL_HOME"
# Expected: identity.crt, identity.key, server.toml (with [agents.smoke-agent]), friends.toml, remotes.toml
# NOT expected: serve.pid, logs/ (those only appear in non-debug mode)
```

- [ ] **Step 5: Final commit if anything unstaged**

```bash
git status
# If there are uncommitted changes (README tweaks, small doc fixes), commit as a single cleanup:
git add -A && git commit -m "chore: final wiring for claude-code:start"
```

---

## Self-review notes (author)

- **Spec coverage:** Every section of the spec maps to a task. Command surface → T7+T8; name resolver → T1; port picker → T2; `.mcp.json` → T3; daemon supervision → T4; `stop` → T5; status extension → T6; error handling cases are all exercised by tests in T1–T5; README updates → T9; final validation → T10.
- **Placeholder scan:** No TBDs. Every step has executable code or a concrete command.
- **Type consistency:** `IsServeRunningResult` types in T4 match what `status.ts` and the orchestrator consume in T6/T7. `EnsureMcpJsonResult` shape used in T3 is not consumed by T7 directly — orchestrator ignores return value. `RunStopResult` shape consumed by T8 bin wiring.
- **DI seams:** All async-non-determinism (network probes, process spawns, time) is behind an injectable option. Tests use stubs; production uses defaults.
- **One deviation called out in T6:** the exact integration point in `status.ts` depends on the existing structure of `runStatus` — implementer needs to read the file before editing. That's explicit in T6 Step 1.
