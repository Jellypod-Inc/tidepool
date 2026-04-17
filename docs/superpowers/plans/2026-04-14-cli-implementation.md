# Tidepool CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a `tidepool` CLI that covers the full day-to-day workflow: initialize a config tree, register agent identities, start the server, manage friends and remote peers, and observe the running system (status, ping, whoami). `package.json` already declares `"bin": { "tidepool": "./dist/bin/cli.js" }`; this plan fills in that entrypoint and its subcommands.

**Architecture:** Commander-v14 based CLI. A single entrypoint at `src/bin/cli.ts` wires root options (`--config-dir`, `--verbose`, `--version`) and registers each subcommand from its own module in `src/cli/`. Every subcommand is a thin shell that (a) parses args, (b) calls existing core helpers (`generateIdentity`, `loadServerConfig`, `addFriend`, `writeFriendsConfig`, `buildStatusOutput`, `pingAgent`, `startServer`, …), (c) writes human-readable output to stdout and errors to stderr, exiting with the right code. The CLI does **not** re-implement business logic — it orchestrates what `src/*.ts` already exposes, and adds one new helper (`writeServerConfig`) for TOML persistence on the server side.

**Tech Stack:** TypeScript 5.9, commander 14, vitest 3.2, `@iarna/toml` 2.2 (already a dep), node-forge (via `generateIdentity`). No new dependencies.

**Spec reference:** No separate spec document — requirements are inferred from:
- `package.json#bin` declaring the binary name and path.
- `src/server.ts:120-122` referencing `"Run 'tidepool register' first."` as part of its error path.
- `src/status.ts`, `src/ping.ts`, `src/friends.ts`, `src/identity.ts`, `src/directory-server.ts` each exposing helpers that need a CLI surface.
- The smoke script at `scripts/smoke.ts` demonstrating the end-to-end workflow the CLI should compress into human-friendly commands.

**Starting state:** HEAD is `46309d5`, 202/202 tests passing, typecheck clean. All work happens in `/Users/piersonmarks/src/tries/2026-04-13-tidepool/tidepool/`. All `pnpm` commands run from that directory.

**Default config directory:** `${XDG_CONFIG_HOME:-$HOME/.config}/tidepool/`. Overridable via `--config-dir <path>` on every subcommand, or `TIDEPOOL_HOME` environment variable.

---

## Scope

**In scope (this plan):**
- CLI scaffold, help text, version, root options.
- `init` — create the config tree with a default `server.toml` and empty `friends.toml`.
- `register <agent-name>` — generate an identity + append the agent to `server.toml`.
- `serve` (alias `start`) — boot the server via `startServer(...)`, handling shutdown on SIGINT/SIGTERM.
- `friend add/list/remove` — manage `friends.toml`.
- `remote add/list/remove` — manage a new `remotes.toml` file that `serve` reads and hands to `startServer`'s `remoteAgents` option.
- `whoami` — print the local identity fingerprints for each registered agent.
- `status` — print `buildStatusOutput(...)` for the configured server.
- `ping <url>` — delegate to `pingAgent(agentCardUrl)` and print via `formatPingResult`.
- `directory serve` — boot `createDirectoryApp()` on a configurable port (a single-file subcommand, no directory-client commands in this plan).
- Global install wiring: `dist/bin/cli.js` is produced by `tsc`, is executable, and has a `#!/usr/bin/env node` shebang preserved in the emitted file.

**Explicitly deferred (not this plan):**
- mDNS advertise/deadvertise helpers (`discovery.mdns` is read by the server but has no CLI surface today).
- Directory-client commands (`cc directory search`, `cc directory resolve`) — usable via the raw HTTP API.
- Interactive friend add with QR codes or verification flows.
- A `logs` subcommand (server writes to stderr today; no log aggregation).
- Uninstall / config migration (`init --force`, schema upgrades).
- Shell completion scripts.

---

## File structure

**New source files (all under `src/`):**
- `src/bin/cli.ts` — commander entry, registers subcommands, compiles to `dist/bin/cli.js` with shebang.
- `src/cli/paths.ts` — `resolveConfigDir(opt)` helper: precedence `--config-dir` > `$TIDEPOOL_HOME` > XDG default.
- `src/cli/output.ts` — tiny `ok(msg)`, `warn(msg)`, `fail(msg, code = 1)` helpers that unify stdout/stderr style.
- `src/cli/init.ts` — `init` subcommand.
- `src/cli/register.ts` — `register <name>` subcommand.
- `src/cli/serve.ts` — `serve` subcommand (also registered as `start`).
- `src/cli/friend.ts` — `friend add|list|remove` command group.
- `src/cli/remote.ts` — `remote add|list|remove` command group + `remotes.toml` I/O.
- `src/cli/whoami.ts` — `whoami` subcommand.
- `src/cli/status.ts` — `status` subcommand (thin wrapper around `buildStatusOutput`).
- `src/cli/ping.ts` — `ping <url>` subcommand.
- `src/cli/directory.ts` — `directory serve [--port]` subcommand.
- `src/config-writer.ts` — new `writeServerConfig(path, config)` and `readOrInitServerConfig(path)` helpers. Parallels `src/friends.ts`'s `writeFriendsConfig` for symmetry.
- `src/cli/remotes-config.ts` — `loadRemotesConfig`/`writeRemotesConfig` + `RemotesConfig` type.

**Modified files:**
- `src/types.ts` — add `RemotesConfig` interface.
- `src/schemas.ts` — add `RemotesConfigSchema`.
- `package.json` — no change to `"bin"`; possibly add a `"prepare": "tsc"` if missing so global installs work.

**Test files:**
- `test/cli/paths.test.ts`
- `test/cli/init.test.ts`
- `test/cli/register.test.ts`
- `test/cli/friend.test.ts`
- `test/cli/remote.test.ts`
- `test/cli/whoami.test.ts`
- `test/cli/status.test.ts`
- `test/cli/ping.test.ts`
- `test/cli/directory.test.ts`
- `test/cli/serve-e2e.test.ts`
- `test/config-writer.test.ts`

**Untouched:** `src/a2a.ts`, `src/server.ts`, `src/streaming.ts`, `src/wire-validation.ts`, `src/errors.ts`, `src/proxy.ts`, `src/middleware.ts`, `src/handshake.ts`, `src/agent-card.ts`, `src/outbound-tls.ts`, `src/rate-limiter.ts`, `src/discovery/**`. The CLI is an additive layer — no business-logic changes.

---

## Task 1: CLI scaffold + root options (TDD)

**Files:**
- Create: `src/bin/cli.ts`
- Create: `src/cli/paths.ts`
- Create: `src/cli/output.ts`
- Create: `test/cli/paths.test.ts`

- [ ] **Step 1: Write the failing test for `resolveConfigDir`**

Create `test/cli/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import { resolveConfigDir } from "../../src/cli/paths.js";

describe("resolveConfigDir", () => {
  it("uses explicit --config-dir when provided", () => {
    expect(resolveConfigDir({ configDir: "/tmp/x" }, {})).toBe("/tmp/x");
  });

  it("falls back to TIDEPOOL_HOME", () => {
    expect(resolveConfigDir({}, { TIDEPOOL_HOME: "/tmp/y" })).toBe("/tmp/y");
  });

  it("falls back to XDG_CONFIG_HOME/tidepool", () => {
    expect(resolveConfigDir({}, { XDG_CONFIG_HOME: "/tmp/cfg" })).toBe(
      "/tmp/cfg/tidepool",
    );
  });

  it("falls back to $HOME/.config/tidepool", () => {
    expect(resolveConfigDir({}, { HOME: "/home/alice" })).toBe(
      "/home/alice/.config/tidepool",
    );
  });

  it("throws when no home is resolvable", () => {
    expect(() => resolveConfigDir({}, {})).toThrow(/config directory/i);
  });

  it("--config-dir beats all env vars", () => {
    expect(
      resolveConfigDir(
        { configDir: "/explicit" },
        { TIDEPOOL_HOME: "/env", HOME: "/home/a" },
      ),
    ).toBe("/explicit");
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm test -- test/cli/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli/paths.ts`**

```ts
import path from "path";

interface CliRootOpts {
  configDir?: string;
}

type Env = Partial<Record<"TIDEPOOL_HOME" | "XDG_CONFIG_HOME" | "HOME", string>>;

export function resolveConfigDir(opts: CliRootOpts, env: Env = process.env): string {
  if (opts.configDir) return opts.configDir;
  if (env.TIDEPOOL_HOME) return env.TIDEPOOL_HOME;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "tidepool");
  if (env.HOME) return path.join(env.HOME, ".config", "tidepool");
  throw new Error(
    "Could not resolve config directory. Set --config-dir, TIDEPOOL_HOME, or HOME.",
  );
}
```

- [ ] **Step 4: Implement `src/cli/output.ts`**

```ts
export function ok(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}
```

- [ ] **Step 5: Implement `src/bin/cli.ts` scaffold**

```ts
#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("tidepool")
  .description("Local-first A2A peer server")
  .version("0.0.1")
  .option("-c, --config-dir <path>", "Override config directory")
  .option("-v, --verbose", "Verbose output");

// Subcommands registered here by later tasks.

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the binary compiles and runs**

Run: `pnpm typecheck && pnpm test -- test/cli/paths.test.ts`
Expected: typecheck clean, 6 tests pass.

Run: `pnpm build && node dist/bin/cli.js --version`
Expected: `0.0.1`.

Run: `pnpm build && node dist/bin/cli.js --help`
Expected: usage block with the program name and `--config-dir` / `--verbose` options.

- [ ] **Step 7: Preserve the shebang in the emitted file**

`tsc` strips the `#!/usr/bin/env node` line. Add a `postbuild` step in `package.json`:

```json
  "scripts": {
    "build": "tsc && node scripts/fix-shebang.mjs",
```

Create `scripts/fix-shebang.mjs`:

```js
import fs from "fs";
const file = "dist/bin/cli.js";
const src = fs.readFileSync(file, "utf-8");
if (!src.startsWith("#!")) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${src}`);
}
fs.chmodSync(file, 0o755);
```

Verify: `pnpm build && head -1 dist/bin/cli.js` prints `#!/usr/bin/env node`.

- [ ] **Step 8: Commit**

```bash
git add src/bin/cli.ts src/cli/paths.ts src/cli/output.ts test/cli/paths.test.ts scripts/fix-shebang.mjs package.json
git commit -m "feat(cli): scaffold tidepool binary with resolveConfigDir"
```

---

## Task 2: `writeServerConfig` helper (TDD)

**Files:**
- Create: `src/config-writer.ts`
- Create: `test/config-writer.test.ts`

Before any CLI command can edit `server.toml`, we need a writer helper. The loader already exists in `src/config.ts`; this adds the round-trip counterpart.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeServerConfig, readOrInitServerConfig } from "../src/config-writer.js";
import { loadServerConfig } from "../src/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-cfg-writer-"));
}

describe("writeServerConfig", () => {
  it("writes a TOML file that round-trips through loadServerConfig", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    const cfg = {
      server: { port: 9900, host: "0.0.0.0", localPort: 9901, rateLimit: "100/hour", streamTimeoutSeconds: 300 },
      agents: {
        "alice-dev": { localEndpoint: "http://127.0.0.1:28800", rateLimit: "50/hour", description: "dev", timeoutSeconds: 30 },
      },
      connectionRequests: { mode: "deny" as const },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" as const },
    };
    writeServerConfig(p, cfg);
    const reloaded = loadServerConfig(p);
    expect(reloaded.server.port).toBe(9900);
    expect(reloaded.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28800");
    expect(reloaded.validation.mode).toBe("warn");
  });
});

describe("readOrInitServerConfig", () => {
  it("returns defaults and creates the file when absent", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    const cfg = readOrInitServerConfig(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(cfg.server.port).toBe(9900);
    expect(cfg.agents).toEqual({});
    expect(cfg.validation.mode).toBe("warn");
  });

  it("returns existing config when file is present", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    fs.writeFileSync(
      p,
      [
        "[server]",
        "port = 7777",
        "host = \"0.0.0.0\"",
        "localPort = 7778",
        "rateLimit = \"100/hour\"",
        "streamTimeoutSeconds = 300",
        "",
        "[connectionRequests]",
        "mode = \"deny\"",
        "",
        "[discovery]",
        "providers = [\"static\"]",
        "cacheTtlSeconds = 300",
      ].join("\n"),
    );
    const cfg = readOrInitServerConfig(p);
    expect(cfg.server.port).toBe(7777);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/config-writer.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/config-writer.ts`**

```ts
import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { loadServerConfig } from "./config.js";
import type { ServerConfig } from "./types.js";

export function writeServerConfig(filePath: string, cfg: ServerConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // TOML requires a plain JSON-shaped object. ServerConfig is already that shape.
  const tomlStr = TOML.stringify(cfg as unknown as TOML.JsonMap);
  fs.writeFileSync(filePath, tomlStr);
}

export function defaultServerConfig(): ServerConfig {
  return {
    server: {
      port: 9900,
      host: "0.0.0.0",
      localPort: 9901,
      rateLimit: "100/hour",
      streamTimeoutSeconds: 300,
    },
    agents: {},
    connectionRequests: { mode: "deny" },
    discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    validation: { mode: "warn" },
  };
}

export function readOrInitServerConfig(filePath: string): ServerConfig {
  if (fs.existsSync(filePath)) return loadServerConfig(filePath);
  const cfg = defaultServerConfig();
  writeServerConfig(filePath, cfg);
  return cfg;
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test -- test/config-writer.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config-writer.ts test/config-writer.test.ts
git commit -m "feat(config): add writeServerConfig / readOrInitServerConfig helpers"
```

---

## Task 3: `init` subcommand (TDD)

**Files:**
- Create: `src/cli/init.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/init.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-init-"));
}

describe("runInit", () => {
  it("creates server.toml, friends.toml, and remotes.toml with defaults", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    expect(fs.existsSync(path.join(dir, "server.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "friends.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "remotes.toml"))).toBe(true);
    const server = fs.readFileSync(path.join(dir, "server.toml"), "utf-8");
    expect(server).toContain("port = 9900");
    expect(server).toContain("mode = \"warn\"");
  });

  it("is idempotent — second init does not overwrite edits", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    fs.appendFileSync(path.join(dir, "server.toml"), "\n# hand-edited\n");
    await runInit({ configDir: dir });
    const server = fs.readFileSync(path.join(dir, "server.toml"), "utf-8");
    expect(server).toContain("# hand-edited");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/init.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/init.ts`**

```ts
import fs from "fs";
import path from "path";
import {
  defaultServerConfig,
  writeServerConfig,
} from "../config-writer.js";
import { writeFriendsConfig } from "../friends.js";
import { writeRemotesConfig } from "./remotes-config.js";

interface RunInitOpts {
  configDir: string;
}

export async function runInit(opts: RunInitOpts): Promise<void> {
  fs.mkdirSync(opts.configDir, { recursive: true });

  const serverPath = path.join(opts.configDir, "server.toml");
  if (!fs.existsSync(serverPath)) {
    writeServerConfig(serverPath, defaultServerConfig());
  }

  const friendsPath = path.join(opts.configDir, "friends.toml");
  if (!fs.existsSync(friendsPath)) {
    writeFriendsConfig(friendsPath, { friends: {} });
  }

  const remotesPath = path.join(opts.configDir, "remotes.toml");
  if (!fs.existsSync(remotesPath)) {
    writeRemotesConfig(remotesPath, { remotes: {} });
  }
}
```

Note: this depends on `src/cli/remotes-config.ts` (created by Task 6). For Task 3 alone, stub it with a minimal `writeRemotesConfig` that writes `[remotes]\n` — Task 6 will replace.

- [ ] **Step 4: Write the stub `src/cli/remotes-config.ts`**

```ts
import fs from "fs";

export interface RemotesConfig {
  remotes: Record<string, never>;
}

export function writeRemotesConfig(filePath: string, _config: RemotesConfig): void {
  fs.writeFileSync(filePath, "[remotes]\n");
}
```

- [ ] **Step 5: Wire into CLI**

In `src/bin/cli.ts`, after the `program` setup and before `parseAsync`:

```ts
import { runInit } from "../cli/init.js";
import { resolveConfigDir } from "../cli/paths.js";
import { ok } from "../cli/output.js";

program
  .command("init")
  .description("Create config files in the config directory")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    await runInit({ configDir });
    ok(`Initialized ${configDir}`);
  });
```

- [ ] **Step 6: Run tests + smoke**

Run: `pnpm typecheck && pnpm test -- test/cli/init.test.ts`
Expected: both tests pass.

Run: `pnpm build && node dist/bin/cli.js init --config-dir /tmp/cc-smoke-init && ls /tmp/cc-smoke-init`
Expected: `friends.toml  remotes.toml  server.toml`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/init.ts src/cli/remotes-config.ts src/bin/cli.ts test/cli/init.test.ts
git commit -m "feat(cli): add init subcommand"
```

---

## Task 4: `register <name>` subcommand (TDD)

**Files:**
- Create: `src/cli/register.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/register.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { loadServerConfig } from "../../src/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-register-"));
}

describe("runRegister", () => {
  it("generates identity files and appends agent to server.toml", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28800",
    });

    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.crt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "agents/alice-dev/identity.key"))).toBe(true);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28800");
    expect(cfg.agents["alice-dev"].rateLimit).toBe("50/hour");
  });

  it("refuses to overwrite an existing agent unless --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    await expect(
      runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28801" }),
    ).rejects.toThrow(/already registered/i);
  });

  it("overwrites when --force is set", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const first = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28800",
    });
    const second = await runRegister({
      configDir: dir,
      name: "alice-dev",
      localEndpoint: "http://127.0.0.1:28801",
      force: true,
    });
    expect(second.fingerprint).not.toBe(first.fingerprint); // new key pair
    const cfg = loadServerConfig(path.join(dir, "server.toml"));
    expect(cfg.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28801");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/register.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/register.ts`**

```ts
import path from "path";
import { generateIdentity } from "../identity.js";
import { loadServerConfig } from "../config.js";
import { writeServerConfig, defaultServerConfig } from "../config-writer.js";
import type { ServerConfig } from "../types.js";

interface RunRegisterOpts {
  configDir: string;
  name: string;
  localEndpoint: string;
  rateLimit?: string;
  description?: string;
  timeoutSeconds?: number;
  force?: boolean;
}

export async function runRegister(opts: RunRegisterOpts): Promise<{ fingerprint: string }> {
  const serverPath = path.join(opts.configDir, "server.toml");
  const cfg: ServerConfig = (() => {
    try {
      return loadServerConfig(serverPath);
    } catch {
      return defaultServerConfig();
    }
  })();

  if (cfg.agents[opts.name] && !opts.force) {
    throw new Error(`Agent "${opts.name}" is already registered. Use --force to overwrite.`);
  }

  const certPath = path.join(opts.configDir, "agents", opts.name, "identity.crt");
  const keyPath = path.join(opts.configDir, "agents", opts.name, "identity.key");

  const identity = await generateIdentity({ name: opts.name, certPath, keyPath });

  cfg.agents[opts.name] = {
    localEndpoint: opts.localEndpoint,
    rateLimit: opts.rateLimit ?? "50/hour",
    description: opts.description ?? "",
    timeoutSeconds: opts.timeoutSeconds ?? 30,
  };

  writeServerConfig(serverPath, cfg);

  return { fingerprint: identity.fingerprint };
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runRegister } from "../cli/register.js";

program
  .command("register <name>")
  .description("Generate an identity and register a local agent")
  .option("-e, --local-endpoint <url>", "Where the local agent listens (e.g. http://127.0.0.1:28800)")
  .option("--rate-limit <spec>", "Per-agent rate limit (default: 50/hour)")
  .option("--description <text>", "Human-readable description")
  .option("--timeout <seconds>", "Per-agent timeout in seconds", (v) => parseInt(v, 10))
  .option("-f, --force", "Overwrite existing identity + config")
  .action(async (name: string, cmdOpts) => {
    if (!cmdOpts.localEndpoint) {
      throw new Error("--local-endpoint is required");
    }
    const configDir = resolveConfigDir(program.opts());
    const result = await runRegister({
      configDir,
      name,
      localEndpoint: cmdOpts.localEndpoint,
      rateLimit: cmdOpts.rateLimit,
      description: cmdOpts.description,
      timeoutSeconds: cmdOpts.timeout,
      force: cmdOpts.force,
    });
    ok(`Registered ${name}`);
    ok(`  fingerprint: ${result.fingerprint}`);
  });
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test -- test/cli/register.test.ts`
Expected: 3 tests pass.

Run: `pnpm build && node dist/bin/cli.js init --config-dir /tmp/cc-smoke-reg && node dist/bin/cli.js register alice-dev --local-endpoint http://127.0.0.1:28800 --config-dir /tmp/cc-smoke-reg`
Expected: output includes `Registered alice-dev` and a `sha256:` fingerprint.

- [ ] **Step 6: Commit**

```bash
git add src/cli/register.ts src/bin/cli.ts test/cli/register.test.ts
git commit -m "feat(cli): add register subcommand"
```

---

## Task 5: `friend add|list|remove` command group (TDD)

**Files:**
- Create: `src/cli/friend.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/friend.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runFriendAdd, runFriendList, runFriendRemove } from "../../src/cli/friend.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-friend-"));
}

const FP = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const FP2 = "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("friend add/list/remove", () => {
  it("add appends to friends.toml; list returns what was added; remove removes it", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    await runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP });
    const listed = await runFriendList({ configDir: dir });
    expect(listed).toEqual([{ handle: "bob", fingerprint: FP }]);

    await runFriendRemove({ configDir: dir, handle: "bob" });
    const after = await runFriendList({ configDir: dir });
    expect(after).toEqual([]);
  });

  it("add with --scope restricts visible agents", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runFriendAdd({
      configDir: dir,
      handle: "carol",
      fingerprint: FP,
      agents: ["alice-dev", "rust-expert"],
    });
    const [entry] = await runFriendList({ configDir: dir });
    expect(entry.agents).toEqual(["alice-dev", "rust-expert"]);
  });

  it("add rejects duplicate handles", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP });
    await expect(
      runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP2 }),
    ).rejects.toThrow(/already exists/i);
  });

  it("remove errors on unknown handle", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await expect(runFriendRemove({ configDir: dir, handle: "ghost" })).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/friend.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/friend.ts`**

```ts
import path from "path";
import { loadFriendsConfig } from "../config.js";
import { addFriend, removeFriend, listFriends, writeFriendsConfig } from "../friends.js";

interface AddOpts {
  configDir: string;
  handle: string;
  fingerprint: string;
  agents?: string[];
}

interface RemoveOpts {
  configDir: string;
  handle: string;
}

interface ListOpts {
  configDir: string;
}

function friendsPath(dir: string): string {
  return path.join(dir, "friends.toml");
}

export async function runFriendAdd(opts: AddOpts): Promise<void> {
  const p = friendsPath(opts.configDir);
  const cfg = loadFriendsConfig(p);
  const next = addFriend(cfg, {
    handle: opts.handle,
    fingerprint: opts.fingerprint,
    agents: opts.agents,
  });
  writeFriendsConfig(p, next);
}

export async function runFriendRemove(opts: RemoveOpts): Promise<void> {
  const p = friendsPath(opts.configDir);
  const cfg = loadFriendsConfig(p);
  const next = removeFriend(cfg, opts.handle);
  writeFriendsConfig(p, next);
}

export async function runFriendList(opts: ListOpts): Promise<{ handle: string; fingerprint: string; agents?: string[] }[]> {
  const cfg = loadFriendsConfig(friendsPath(opts.configDir));
  return listFriends(cfg);
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runFriendAdd, runFriendList, runFriendRemove } from "../cli/friend.js";

const friend = program.command("friend").description("Manage friends");

friend
  .command("add <handle> <fingerprint>")
  .description("Register a friend by handle and cert fingerprint")
  .option("-s, --scope <agents...>", "Restrict visibility to specific local agents")
  .action(async (handle: string, fingerprint: string, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    await runFriendAdd({ configDir, handle, fingerprint, agents: cmdOpts.scope });
    ok(`Added friend ${handle}`);
  });

friend
  .command("list")
  .description("List known friends")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const entries = await runFriendList({ configDir });
    if (entries.length === 0) {
      ok("(no friends)");
      return;
    }
    for (const e of entries) {
      const scope = e.agents ? ` [scoped: ${e.agents.join(", ")}]` : "";
      ok(`${e.handle}  ${e.fingerprint}${scope}`);
    }
  });

friend
  .command("remove <handle>")
  .description("Remove a friend")
  .action(async (handle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runFriendRemove({ configDir, handle });
    ok(`Removed friend ${handle}`);
  });
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test -- test/cli/friend.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/friend.ts src/bin/cli.ts test/cli/friend.test.ts
git commit -m "feat(cli): add friend add/list/remove subcommands"
```

---

## Task 6: `remote add|list|remove` + `remotes.toml` (TDD)

**Files:**
- Modify: `src/types.ts` (add `RemotesConfig`)
- Modify: `src/schemas.ts` (add `RemotesConfigSchema`)
- Rewrite: `src/cli/remotes-config.ts` (replace Task 3's stub)
- Create: `src/cli/remote.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/remote.test.ts`

- [ ] **Step 1: Define the config shape — `src/types.ts`**

Append:

```ts
export interface RemotesConfig {
  remotes: Record<string, RemoteAgent>;
}
```

`RemoteAgent` already exists in `src/types.ts`. The map key is the `localHandle`.

- [ ] **Step 2: Add schema — `src/schemas.ts`**

Append (at the bottom of the file, near the other exported schemas):

```ts
const RemoteAgentSchema = z.object({
  localHandle: z.string().min(1),
  remoteEndpoint: z.string().url(),
  remoteTenant: z.string().min(1),
  certFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

export const RemotesConfigSchema = z.object({
  remotes: z.record(z.string(), RemoteAgentSchema).default({}),
});
```

- [ ] **Step 3: Write the failing test**

Create `test/cli/remote.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRemoteAdd, runRemoteList, runRemoteRemove } from "../../src/cli/remote.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-remote-"));
}

const FP = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("remote add/list/remove", () => {
  it("round-trips a remote agent through add/list/remove", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    await runRemoteAdd({
      configDir: dir,
      localHandle: "bobs-rust",
      remoteEndpoint: "https://127.0.0.1:29900",
      remoteTenant: "rust-expert",
      certFingerprint: FP,
    });

    const listed = await runRemoteList({ configDir: dir });
    expect(listed).toEqual([
      {
        localHandle: "bobs-rust",
        remoteEndpoint: "https://127.0.0.1:29900",
        remoteTenant: "rust-expert",
        certFingerprint: FP,
      },
    ]);

    await runRemoteRemove({ configDir: dir, localHandle: "bobs-rust" });
    expect(await runRemoteList({ configDir: dir })).toEqual([]);
  });

  it("rejects a bad fingerprint", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await expect(
      runRemoteAdd({
        configDir: dir,
        localHandle: "x",
        remoteEndpoint: "https://h:1",
        remoteTenant: "t",
        certFingerprint: "not-a-fingerprint",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run — expect failure**

Run: `pnpm test -- test/cli/remote.test.ts`
Expected: module not found / schema not exported.

- [ ] **Step 5: Rewrite `src/cli/remotes-config.ts`**

```ts
import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { RemotesConfigSchema } from "../schemas.js";
import type { RemotesConfig } from "../types.js";

export function loadRemotesConfig(filePath: string): RemotesConfig {
  if (!fs.existsSync(filePath)) return { remotes: {} };
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(raw);
  const stripped = JSON.parse(JSON.stringify(parsed));
  return RemotesConfigSchema.parse(stripped) as RemotesConfig;
}

export function writeRemotesConfig(filePath: string, cfg: RemotesConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, TOML.stringify(cfg as unknown as TOML.JsonMap));
}
```

- [ ] **Step 6: Implement `src/cli/remote.ts`**

```ts
import path from "path";
import { loadRemotesConfig, writeRemotesConfig } from "./remotes-config.js";
import type { RemoteAgent } from "../types.js";

interface AddOpts extends RemoteAgent {
  configDir: string;
}

interface RemoveOpts {
  configDir: string;
  localHandle: string;
}

interface ListOpts {
  configDir: string;
}

function remotesPath(dir: string): string {
  return path.join(dir, "remotes.toml");
}

export async function runRemoteAdd(opts: AddOpts): Promise<void> {
  const p = remotesPath(opts.configDir);
  const cfg = loadRemotesConfig(p);
  if (cfg.remotes[opts.localHandle]) {
    throw new Error(`Remote "${opts.localHandle}" already exists`);
  }
  const { configDir: _, ...entry } = opts;
  cfg.remotes[opts.localHandle] = entry;
  writeRemotesConfig(p, cfg);
}

export async function runRemoteRemove(opts: RemoveOpts): Promise<void> {
  const p = remotesPath(opts.configDir);
  const cfg = loadRemotesConfig(p);
  if (!cfg.remotes[opts.localHandle]) {
    throw new Error(`Remote "${opts.localHandle}" not found`);
  }
  delete cfg.remotes[opts.localHandle];
  writeRemotesConfig(p, cfg);
}

export async function runRemoteList(opts: ListOpts): Promise<RemoteAgent[]> {
  const cfg = loadRemotesConfig(remotesPath(opts.configDir));
  return Object.values(cfg.remotes);
}
```

- [ ] **Step 7: Wire into `src/bin/cli.ts`**

```ts
import { runRemoteAdd, runRemoteList, runRemoteRemove } from "../cli/remote.js";

const remote = program.command("remote").description("Manage remote peers");

remote
  .command("add <localHandle> <remoteEndpoint> <remoteTenant> <certFingerprint>")
  .description("Register a remote peer to proxy")
  .action(async (localHandle, remoteEndpoint, remoteTenant, certFingerprint) => {
    const configDir = resolveConfigDir(program.opts());
    await runRemoteAdd({ configDir, localHandle, remoteEndpoint, remoteTenant, certFingerprint });
    ok(`Added remote ${localHandle} → ${remoteEndpoint}/${remoteTenant}`);
  });

remote
  .command("list")
  .description("List registered remote peers")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const entries = await runRemoteList({ configDir });
    if (entries.length === 0) {
      ok("(no remotes)");
      return;
    }
    for (const e of entries) {
      ok(`${e.localHandle}  →  ${e.remoteEndpoint}/${e.remoteTenant}  [${e.certFingerprint.slice(0, 20)}…]`);
    }
  });

remote
  .command("remove <localHandle>")
  .description("Remove a remote peer")
  .action(async (localHandle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runRemoteRemove({ configDir, localHandle });
    ok(`Removed remote ${localHandle}`);
  });
```

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm test -- test/cli/remote.test.ts`
Expected: 2 tests pass. Re-run the full suite to confirm Task 3's `init` test still passes with the new `writeRemotesConfig` implementation.

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/schemas.ts src/cli/remotes-config.ts src/cli/remote.ts src/bin/cli.ts test/cli/remote.test.ts
git commit -m "feat(cli): add remote add/list/remove with remotes.toml"
```

---

## Task 7: `whoami` subcommand (TDD)

**Files:**
- Create: `src/cli/whoami.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/whoami.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runWhoami } from "../../src/cli/whoami.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-whoami-"));
}

describe("runWhoami", () => {
  it("returns one entry per registered agent with its fingerprint", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    await runRegister({ configDir: dir, name: "rust-expert", localEndpoint: "http://127.0.0.1:38800" });

    const entries = await runWhoami({ configDir: dir });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["alice-dev", "rust-expert"]);
    for (const e of entries) {
      expect(e.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("returns [] when no agents are registered", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    expect(await runWhoami({ configDir: dir })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/whoami.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/whoami.ts`**

```ts
import fs from "fs";
import path from "path";
import { loadServerConfig } from "../config.js";
import { getFingerprint } from "../identity.js";

interface RunWhoamiOpts {
  configDir: string;
}

export async function runWhoami(opts: RunWhoamiOpts): Promise<{ name: string; fingerprint: string }[]> {
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const out: { name: string; fingerprint: string }[] = [];
  for (const name of Object.keys(cfg.agents)) {
    const certPath = path.join(opts.configDir, "agents", name, "identity.crt");
    if (!fs.existsSync(certPath)) continue;
    const pem = fs.readFileSync(certPath, "utf-8");
    out.push({ name, fingerprint: getFingerprint(pem) });
  }
  return out;
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runWhoami } from "../cli/whoami.js";

program
  .command("whoami")
  .description("Print local identities and their fingerprints")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const entries = await runWhoami({ configDir });
    if (entries.length === 0) {
      ok("(no local agents — run 'tidepool register <name>')");
      return;
    }
    for (const e of entries) ok(`${e.name}  ${e.fingerprint}`);
  });
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck && pnpm test -- test/cli/whoami.test.ts`
Expected: 2 tests pass.

```bash
git add src/cli/whoami.ts src/bin/cli.ts test/cli/whoami.test.ts
git commit -m "feat(cli): add whoami subcommand"
```

---

## Task 8: `status` subcommand (TDD)

**Files:**
- Create: `src/cli/status.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runStatus } from "../../src/cli/status.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-"));
}

describe("runStatus", () => {
  it("returns a multi-line string containing server info, agent count, friend count", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:28800" });
    const out = await runStatus({ configDir: dir });
    expect(out).toContain("Tidepool Status");
    expect(out).toContain("alice-dev");
    expect(out).toContain("0 friends");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/status.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/status.ts`**

```ts
import path from "path";
import { loadServerConfig, loadFriendsConfig } from "../config.js";
import { buildStatusOutput } from "../status.js";

interface RunStatusOpts {
  configDir: string;
}

export async function runStatus(opts: RunStatusOpts): Promise<string> {
  const server = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const friends = loadFriendsConfig(path.join(opts.configDir, "friends.toml"));
  return buildStatusOutput(server, friends);
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runStatus } from "../cli/status.js";

program
  .command("status")
  .description("Show configured server + agents + friends")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const out = await runStatus({ configDir });
    ok(out);
  });
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck && pnpm test -- test/cli/status.test.ts`
Expected: 1 test passes.

```bash
git add src/cli/status.ts src/bin/cli.ts test/cli/status.test.ts
git commit -m "feat(cli): add status subcommand"
```

---

## Task 9: `ping <url>` subcommand (TDD)

**Files:**
- Create: `src/cli/ping.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/ping.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import express from "express";
import http from "http";
import { runPing } from "../../src/cli/ping.js";

describe("runPing", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.get("/card", (_req, res) => {
      res.json({
        name: "test-agent",
        description: "hello",
        url: "http://localhost",
        version: "1.0.0",
        skills: [{ id: "s1", name: "s1", description: "" }],
        defaultInputModes: [],
        defaultOutputModes: [],
        capabilities: {},
        securitySchemes: {},
        securityRequirements: [],
      });
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  it("returns a formatted line with REACHABLE for a real agent card", async () => {
    const out = await runPing({ url: `http://127.0.0.1:${port}/card` });
    expect(out).toContain("REACHABLE");
    expect(out).toContain("test-agent");
  });

  it("returns UNREACHABLE when the endpoint is closed", async () => {
    const out = await runPing({ url: `http://127.0.0.1:1/nope` });
    expect(out).toContain("UNREACHABLE");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/ping.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/ping.ts`**

```ts
import { pingAgent, formatPingResult } from "../ping.js";

interface RunPingOpts {
  url: string;
}

export async function runPing(opts: RunPingOpts): Promise<string> {
  const result = await pingAgent(opts.url);
  return formatPingResult(opts.url, result);
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runPing } from "../cli/ping.js";

program
  .command("ping <url>")
  .description("Fetch an Agent Card and report reachability + metadata")
  .action(async (url: string) => {
    const out = await runPing({ url });
    ok(out);
  });
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck && pnpm test -- test/cli/ping.test.ts`
Expected: 2 tests pass.

```bash
git add src/cli/ping.ts src/bin/cli.ts test/cli/ping.test.ts
git commit -m "feat(cli): add ping subcommand"
```

---

## Task 10: `serve` subcommand with graceful shutdown (TDD + e2e)

**Files:**
- Create: `src/cli/serve.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/serve-e2e.test.ts`

`serve` is the highest-value command — it boots the server. This task wires `remotes.toml` through to `startServer`'s `remoteAgents` option and handles shutdown signals.

- [ ] **Step 1: Write the failing e2e test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRegister } from "../../src/cli/register.js";
import { runServe } from "../../src/cli/serve.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-serve-"));
}

describe("runServe (programmatic)", () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
  });

  it("starts the server and returns a stop() handle; /.well-known/agent-card.json responds", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runRegister({ configDir: dir, name: "alice-dev", localEndpoint: "http://127.0.0.1:48800" });

    // Pin ports so we know where to curl.
    const serverToml = fs.readFileSync(path.join(dir, "server.toml"), "utf-8")
      .replace(/port = \d+/, "port = 48900")
      .replace(/localPort = \d+/, "localPort = 48901");
    fs.writeFileSync(path.join(dir, "server.toml"), serverToml);

    const handle = await runServe({ configDir: dir });
    stopFn = handle.stop;

    const res = await fetch("http://127.0.0.1:48901/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = await res.json() as { skills: { id: string }[] };
    expect(card.skills.map((s) => s.id)).toContain("alice-dev");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/serve-e2e.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/serve.ts`**

```ts
import path from "path";
import { startServer } from "../server.js";
import { loadRemotesConfig } from "./remotes-config.js";
import type { RemoteAgent } from "../types.js";

interface RunServeOpts {
  configDir: string;
}

export interface ServeHandle {
  stop: () => Promise<void>;
}

export async function runServe(opts: RunServeOpts): Promise<ServeHandle> {
  const remotesCfg = loadRemotesConfig(path.join(opts.configDir, "remotes.toml"));
  const remoteAgents: RemoteAgent[] = Object.values(remotesCfg.remotes);

  const server = await startServer({
    configDir: opts.configDir,
    remoteAgents,
  });

  return {
    stop: async () => {
      server.close();
      // Give sockets a tick to unbind before returning.
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts` with signal handling**

```ts
import { runServe } from "../cli/serve.js";

program
  .command("serve")
  .alias("start")
  .description("Boot the Tidepool server")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const handle = await runServe({ configDir });
    const shutdown = async (signal: string) => {
      process.stderr.write(`\nReceived ${signal}, shutting down...\n`);
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    // Keep the event loop alive — startServer's listeners already do this,
    // but in case both sockets close the process should still exit cleanly.
  });
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test -- test/cli/serve-e2e.test.ts`
Expected: 1 test passes.

Run full suite: `pnpm test`
Expected: all prior tests still pass.

- [ ] **Step 6: Manual smoke**

```bash
pnpm build
TMPDIR=$(mktemp -d)
node dist/bin/cli.js init --config-dir $TMPDIR
node dist/bin/cli.js register alice-dev --local-endpoint http://127.0.0.1:28800 --config-dir $TMPDIR
# In another shell:
node dist/bin/cli.js serve --config-dir $TMPDIR &
SERVE=$!
sleep 1
curl -s http://127.0.0.1:9901/.well-known/agent-card.json | head -c 200
kill -INT $SERVE
```

Expected: Agent Card JSON prints; server exits cleanly on SIGINT.

- [ ] **Step 7: Commit**

```bash
git add src/cli/serve.ts src/bin/cli.ts test/cli/serve-e2e.test.ts
git commit -m "feat(cli): add serve subcommand with graceful shutdown"
```

---

## Task 11: `directory serve` subcommand (TDD)

**Files:**
- Create: `src/cli/directory.ts`
- Modify: `src/bin/cli.ts`
- Create: `test/cli/directory.test.ts`

The directory server is standalone — it does not read the main config. A single subcommand hosts `createDirectoryApp()` on a configurable port.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { runDirectoryServe } from "../../src/cli/directory.js";

describe("runDirectoryServe", () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
  });

  it("boots createDirectoryApp and returns stop()", async () => {
    const handle = await runDirectoryServe({ port: 0 });
    stopFn = handle.stop;

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect([200, 404]).toContain(res.status);
  });
});
```

Note: `/health` may or may not exist on `createDirectoryApp` — the assertion accepts either 200 or 404. If the underlying app exposes a different probe endpoint, adjust accordingly. The test's purpose is to confirm the listener is actually reachable.

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test -- test/cli/directory.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/directory.ts`**

```ts
import http from "http";
import { createDirectoryApp } from "../directory-server.js";

interface RunOpts {
  port: number;
  host?: string;
}

export interface DirectoryHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function runDirectoryServe(opts: RunOpts): Promise<DirectoryHandle> {
  const { app } = createDirectoryApp();
  const server = http.createServer(app);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const addr = server.address() as { port: number };
  return {
    port: addr.port,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 4: Wire into `src/bin/cli.ts`**

```ts
import { runDirectoryServe } from "../cli/directory.js";

const directory = program.command("directory").description("Directory service");

directory
  .command("serve")
  .description("Run a standalone directory server")
  .option("-p, --port <port>", "Listen port", (v) => parseInt(v, 10), 9100)
  .option("-h, --host <host>", "Bind host", "127.0.0.1")
  .action(async (cmdOpts) => {
    const handle = await runDirectoryServe({ port: cmdOpts.port, host: cmdOpts.host });
    ok(`Directory listening on http://${cmdOpts.host}:${handle.port}`);
    const shutdown = async () => {
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck && pnpm test -- test/cli/directory.test.ts`
Expected: 1 test passes.

```bash
git add src/cli/directory.ts src/bin/cli.ts test/cli/directory.test.ts
git commit -m "feat(cli): add directory serve subcommand"
```

---

## Task 12: Help text polish + final smoke

**Files:**
- Modify: `src/bin/cli.ts` (help text improvements)
- Modify: `scripts/smoke.ts` (optional: convert to CLI-based setup to dogfood it)

- [ ] **Step 1: Pass `--help` manually and list ergonomic issues**

Run: `pnpm build && node dist/bin/cli.js --help && echo '---' && node dist/bin/cli.js friend --help && node dist/bin/cli.js remote --help && node dist/bin/cli.js directory --help`

Look for: missing descriptions, missing examples, unclear required-vs-optional options. Fix inline in `src/bin/cli.ts` using `.addHelpText("after", ...)` for examples.

- [ ] **Step 2: Add examples to the top-level help**

```ts
program.addHelpText(
  "after",
  `\nExamples:\n` +
    `  $ tidepool init\n` +
    `  $ tidepool register alice-dev --local-endpoint http://127.0.0.1:28800\n` +
    `  $ tidepool whoami\n` +
    `  $ tidepool friend add bob sha256:...\n` +
    `  $ tidepool remote add bobs-rust https://peer:29900 rust-expert sha256:...\n` +
    `  $ tidepool serve\n`,
);
```

- [ ] **Step 3: Run the full suite + lint**

Run: `pnpm typecheck && pnpm test`
Expected: all tests (baseline 202 + new CLI tests, likely ~225) pass.

- [ ] **Step 4: End-to-end dogfood**

Boot two servers using only CLI commands. From a scratch tmpdir:

```bash
ALICE=/tmp/alice-cli  BOB=/tmp/bob-cli
rm -rf $ALICE $BOB
node dist/bin/cli.js init --config-dir $ALICE
node dist/bin/cli.js init --config-dir $BOB
node dist/bin/cli.js register alice-dev --local-endpoint http://127.0.0.1:28800 --config-dir $ALICE
node dist/bin/cli.js register rust-expert --local-endpoint http://127.0.0.1:38800 --config-dir $BOB
ALICE_FP=$(node dist/bin/cli.js whoami --config-dir $ALICE | awk '{print $2}')
BOB_FP=$(node dist/bin/cli.js whoami --config-dir $BOB | awk '{print $2}')
node dist/bin/cli.js friend add alices-dev "$ALICE_FP" --config-dir $BOB
node dist/bin/cli.js friend add bobs-rust-expert "$BOB_FP" --config-dir $ALICE
node dist/bin/cli.js remote add bobs-rust https://127.0.0.1:29900 rust-expert "$BOB_FP" --config-dir $ALICE
node dist/bin/cli.js remote add alices-dev https://127.0.0.1:19900 alice-dev "$ALICE_FP" --config-dir $BOB

# In separate shells (or with &):
node dist/bin/cli.js serve --config-dir $ALICE &
node dist/bin/cli.js serve --config-dir $BOB &

sleep 1
node dist/bin/cli.js ping http://127.0.0.1:9901/.well-known/agent-card.json
```

Expected: the `ping` prints `REACHABLE  tidepool (...ms)` with both `alice-dev` and `bobs-rust` listed as skills.

- [ ] **Step 5: Commit**

```bash
git add src/bin/cli.ts
git commit -m "docs(cli): add help examples to root command"
```

---

## Verification (run after every task)

```bash
pnpm typecheck && pnpm test
```

Both must pass. TDD tasks may transiently fail between the red-write and green-implement steps — that's expected.

---

## Explicitly deferred (future follow-ups, NOT part of this plan)

- **`mdns advertise` / `mdns browse`** — today `ServerConfig.discovery.mdns` is loaded but there's no CLI surface. Add when mDNS is used.
- **Directory-client subcommands** (`tidepool directory search <query>`, `tidepool directory resolve <handle>`) — usable via raw HTTP today.
- **Friend verification workflows** — QR codes, OOB fingerprint display, verification TTL. Currently friendship is asymmetric: each side adds the other by fingerprint.
- **`logs` subcommand** — no log aggregation exists; server writes to stderr today.
- **Config migration** (`tidepool upgrade`) — schemas are versioned via zod defaults; when a backwards-incompatible change lands, add this.
- **Shell completion** — `tidepool completion bash|zsh|fish`. Commander has a plugin but not wired here.
- **`register --import <cert.pem> <key.pem>`** — today `register` always generates fresh keys. Import of existing key pairs is deferred.
- **`friend add --from-url <agent-card-url>`** — fetch the card, print its fingerprint, confirm, then add. Current `friend add` requires a pre-known fingerprint.

---

## Done state

- `pnpm typecheck` clean.
- `pnpm test` green (baseline 202 + new CLI tests).
- `pnpm build && ls dist/bin/cli.js` produces an executable file with a `#!/usr/bin/env node` shebang.
- All of the following commands work:
  - `tidepool --version` prints the package version.
  - `tidepool init` creates `server.toml`, `friends.toml`, `remotes.toml`.
  - `tidepool register <name> --local-endpoint <url>` produces identity files and updates `server.toml`.
  - `tidepool whoami` prints each local identity's fingerprint.
  - `tidepool friend add|list|remove` round-trip through `friends.toml`.
  - `tidepool remote add|list|remove` round-trip through `remotes.toml`.
  - `tidepool status` prints a human-readable summary.
  - `tidepool ping <url>` fetches and summarizes an Agent Card.
  - `tidepool serve` boots the server (reading `remotes.toml` for `remoteAgents`) and exits cleanly on SIGINT/SIGTERM.
  - `tidepool directory serve [--port]` runs the standalone directory server.
- `npm install -g .` (after `pnpm build`) installs `tidepool` as a global binary.
