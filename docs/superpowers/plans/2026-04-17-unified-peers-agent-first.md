# Unified Peers + Agent-First CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `friends.toml` + `remotes.toml` with a single `peers.toml`, and replace the `friend` + `remote` CLI verbs with an agent-first flow (`tidepool agent add/ls/rm/refresh`). Adding one of a peer's agents in one command establishes bidirectional trust, writes the peer entry, and registers the agent in a local namespace that compresses to minimally-unambiguous handles when exposed to adapters.

**Architecture:** Single `peers.toml` source of truth, keyed by a peer handle, with trust anchor (fingerprint today, `did:dht:...` later as a nullable field), endpoint, and a list of the peer's agents I've chosen to expose locally. Daemon projects this into a minimally-unambiguous namespace for adapters — bare when a name is globally unique, peer-scoped (`bob/writer`) when it collides. Inbound trust, outbound routing, and handshake all resolve through `peers.toml`. Peer trust is asymmetric and policy-driven: I add a peer unilaterally; the peer's `connectionRequests.mode` gates inbound; successful handshake auto-persists both sides.

**Tech Stack:** TypeScript (ESM, strict), Zod, TOML (`@iarna/toml`), Express, Vitest, pnpm workspace.

---

## Design decisions locked in (from grill-me session 2026-04-17)

1. **Identity anchor:** `fingerprint` today, `did:dht:...` later. `peers.toml` has both fields; `did` is omitted/nullable until DIDs land.
2. **Onboarding:** `tidepool agent add <endpoint> <name>` — daemon fetches the peer's agent card (unpinned HTTPS), observes the cert fingerprint, TOFUs it (prompts user once), writes a peer entry, registers the agent in local namespace.
3. **Namespace:** canonical scoped (`peers.<peer>.agents.<name>`) in storage; projected to minimally-unambiguous when exposed via `/peers` and `list_peers`. Collisions at peer level force `--alias`. No agent-level aliases.
4. **Trust:** bidirectional on add. Handshake (existing `CONNECTION_REQUEST` flow) auto-persists remote peers on accept. Asymmetric: I add unilaterally; peer's policy gates inbound.
5. **Stale peers:** mark, don't prune. `list_peers` reports offline; `agent prune` is manual cleanup (deferred — not in this plan).
6. **No migration:** clean break. Users re-add after upgrade.
7. **CLI:** `agent add/ls/rm/refresh` as primary; `peer ls` as low-level debug. Drop `friend` and `remote` entirely. Interactive `tidepool add <endpoint>` deferred to `tasks/10-interactive-agent-add.md`.
8. **Design principle amendment:** CLAUDE.md §2 — "Network topology is opaque; peer identity is visible via peer-scoped handles."

---

## File structure

**Create:**
- `src/peers/config.ts` — load/save `peers.toml`
- `src/peers/resolve.ts` — scoped-handle parsing + projection logic (bare vs scoped)
- `src/cli/agent.ts` — `agent add/ls/rm/refresh` subcommands
- `test/peers/config.test.ts`
- `test/peers/resolve.test.ts`
- `test/cli/agent.test.ts`
- `test/peers-endpoint-scoped.test.ts`

**Modify:**
- `src/schemas.ts` — add `PeersConfigSchema`; remove `FriendsConfigSchema`, `RemotesConfigSchema`
- `src/types.ts` — add `PeersConfig`, `Peer`, `PeerAgent`; remove `FriendsConfig`, `RemotesConfig`, `RemoteAgent`
- `src/config-holder.ts` — replace `friends()` + `remotes()` with `peers()`, hot-reload `peers.toml`
- `src/cli/init.ts` — create empty `peers.toml`; stop creating `friends.toml`/`remotes.toml`
- `src/cli/status.ts` — show peers + agents
- `src/bin/cli.ts` — wire `agent` command, drop `friend` + `remote`
- `src/middleware.ts` — inbound trust lookup via peers
- `src/handshake.ts` — persist accepted CONNECTION_REQUESTs into `peers.toml`
- `src/server.ts` — `/peers` endpoint returns scoped projection; `/message:send` routes outbound via peers
- `src/outbound-tls.ts` — pin cert via peers entry
- `adapters/claude-code/src/peers-client.ts` — type the scoped response
- `adapters/claude-code/src/channel.ts` — pass scoped handles through to send
- `adapters/claude-code/src/outbound.ts` — support `peer/agent` URL path
- `CLAUDE.md` — amend principle §2
- `docs/architecture.md` — §1, §5 state, §6 protocol, §7 adapter
- `README.md` — onboarding

**Delete:**
- `src/cli/friend.ts`
- `src/cli/remote.ts`
- `src/cli/remotes-config.ts`
- `test/friends.test.ts` (keep as a reference for handshake persistence coverage — rewrite into `test/peers/handshake.test.ts`)
- `test/cli/remote.test.ts` and `test/cli/remotes-config.test.ts` if present

---

## Tasks

### Task 1: Define `PeersConfig` schema + types

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/types.ts`
- Test: `test/schemas.test.ts` (add cases; don't delete existing)

- [ ] **Step 1: Write the failing schema tests**

Append to `test/schemas.test.ts`:

```ts
import { PeersConfigSchema } from "../src/schemas.js";

describe("PeersConfigSchema", () => {
  it("accepts a peer with fingerprint only (DID omitted)", () => {
    const input = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice.example:9900",
          agents: ["writer", "rust-expert"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).not.toThrow();
  });

  it("accepts a peer with both did and fingerprint", () => {
    const input = {
      peers: {
        bob: {
          did: "did:dht:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          fingerprint: "sha256:" + "b".repeat(64),
          endpoint: "https://bob.example:9900",
          agents: ["trader"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).not.toThrow();
  });

  it("rejects a peer with neither did nor fingerprint", () => {
    const input = {
      peers: {
        anon: {
          endpoint: "https://anon:9900",
          agents: ["agent"],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).toThrow();
  });

  it("defaults empty agents list", () => {
    const parsed = PeersConfigSchema.parse({
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice:9900",
        },
      },
    });
    expect(parsed.peers.alice.agents).toEqual([]);
  });

  it("rejects malformed fingerprint", () => {
    const input = {
      peers: {
        x: {
          fingerprint: "sha256:nothex",
          endpoint: "https://x:9900",
          agents: [],
        },
      },
    };
    expect(() => PeersConfigSchema.parse(input)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/schemas.test.ts -t PeersConfigSchema`
Expected: FAIL — `PeersConfigSchema` not exported

- [ ] **Step 3: Add the schema**

In `src/schemas.ts`, append:

```ts
const PeerAgentNameSchema = z.string().min(1);

const PeerEntrySchema = z
  .object({
    did: z.string().regex(/^did:dht:[A-Za-z0-9]+$/).optional(),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
    endpoint: z.string().url(),
    agents: z.array(PeerAgentNameSchema).default([]),
  })
  .refine((p) => p.did || p.fingerprint, {
    message: "peer must have did or fingerprint (or both)",
  });

export const PeersConfigSchema = z.object({
  peers: z.record(z.string().min(1), PeerEntrySchema).default({}),
});
```

- [ ] **Step 4: Add the types**

In `src/types.ts`, append:

```ts
import type { z } from "zod";
import type { PeersConfigSchema } from "./schemas.js";

export type PeersConfig = z.infer<typeof PeersConfigSchema>;
export type PeerEntry = PeersConfig["peers"][string];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/schemas.test.ts -t PeersConfigSchema`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/types.ts test/schemas.test.ts
git commit -m "feat(peers): add PeersConfigSchema and types"
```

---

### Task 2: `peers/config.ts` — load / save `peers.toml`

**Files:**
- Create: `src/peers/config.ts`
- Create: `test/peers/config.test.ts`

- [ ] **Step 1: Write failing load/save tests**

Create `test/peers/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPeersConfig, writePeersConfig } from "../../src/peers/config.js";

describe("peers/config", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when file does not exist", () => {
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(cfg).toEqual({ peers: {} });
  });

  it("round-trips through TOML", () => {
    const filePath = path.join(dir, "peers.toml");
    const cfg = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://alice.example:9900",
          agents: ["writer", "rust-expert"],
        },
      },
    };
    writePeersConfig(filePath, cfg);
    const loaded = loadPeersConfig(filePath);
    expect(loaded).toEqual(cfg);
  });

  it("rejects malformed TOML with a useful error", () => {
    const filePath = path.join(dir, "peers.toml");
    fs.writeFileSync(
      filePath,
      `[peers.alice]\nfingerprint = "sha256:wronghex"\nendpoint = "https://alice:9900"\nagents = []\n`,
    );
    expect(() => loadPeersConfig(filePath)).toThrow(/fingerprint/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run test/peers/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `src/peers/config.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { PeersConfigSchema } from "../schemas.js";
import type { PeersConfig } from "../types.js";

export function loadPeersConfig(filePath: string): PeersConfig {
  if (!fs.existsSync(filePath)) return { peers: {} };
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(raw);
  const stripped = JSON.parse(JSON.stringify(parsed));
  return PeersConfigSchema.parse(stripped);
}

export function writePeersConfig(filePath: string, cfg: PeersConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validated = PeersConfigSchema.parse(cfg);
  fs.writeFileSync(filePath, TOML.stringify(validated as unknown as TOML.JsonMap));
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/peers/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/peers/config.ts test/peers/config.test.ts
git commit -m "feat(peers): add peers.toml load/save"
```

---

### Task 3: `peers/resolve.ts` — scoped handle parsing + projection

**Files:**
- Create: `src/peers/resolve.ts`
- Create: `test/peers/resolve.test.ts`

- [ ] **Step 1: Write failing tests for parse + project**

Create `test/peers/resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseScoped,
  projectHandles,
  resolveHandle,
} from "../../src/peers/resolve.js";
import type { PeersConfig } from "../../src/types.js";

describe("parseScoped", () => {
  it("returns bare handle when no slash", () => {
    expect(parseScoped("writer")).toEqual({ peer: null, agent: "writer" });
  });
  it("splits on slash", () => {
    expect(parseScoped("bob/writer")).toEqual({ peer: "bob", agent: "writer" });
  });
  it("rejects empty segments", () => {
    expect(() => parseScoped("/writer")).toThrow();
    expect(() => parseScoped("bob/")).toThrow();
    expect(() => parseScoped("")).toThrow();
  });
  it("rejects multiple slashes", () => {
    expect(() => parseScoped("a/b/c")).toThrow();
  });
});

describe("projectHandles", () => {
  const peers: PeersConfig = {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["writer", "rust-expert"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer", "trader"],
      },
    },
  };

  it("returns bare names when globally unique", () => {
    const names = projectHandles(peers, ["local-agent"]);
    expect(names).toContain("local-agent");
    expect(names).toContain("rust-expert");
    expect(names).toContain("trader");
  });

  it("returns scoped names for colliding agents", () => {
    const names = projectHandles(peers, ["local-agent"]);
    expect(names).toContain("alice/writer");
    expect(names).toContain("bob/writer");
    expect(names).not.toContain("writer");
  });

  it("local agent beats a remote with the same name → remote becomes scoped", () => {
    const names = projectHandles(peers, ["writer"]);
    expect(names).toContain("writer"); // local
    expect(names).toContain("alice/writer");
    expect(names).toContain("bob/writer");
  });
});

describe("resolveHandle", () => {
  const peers: PeersConfig = {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["rust-expert"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer"],
      },
    },
  };

  it("resolves a scoped handle to its peer + agent", () => {
    expect(resolveHandle("bob/writer", peers, [])).toEqual({
      kind: "remote",
      peer: "bob",
      agent: "writer",
    });
  });

  it("resolves a bare unambiguous remote", () => {
    expect(resolveHandle("rust-expert", peers, [])).toEqual({
      kind: "remote",
      peer: "alice",
      agent: "rust-expert",
    });
  });

  it("resolves a bare local agent", () => {
    expect(resolveHandle("mine", peers, ["mine"])).toEqual({
      kind: "local",
      agent: "mine",
    });
  });

  it("errors on ambiguous bare handle", () => {
    const colliding: PeersConfig = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://a:9900",
          agents: ["writer"],
        },
        bob: {
          fingerprint: "sha256:" + "b".repeat(64),
          endpoint: "https://b:9900",
          agents: ["writer"],
        },
      },
    };
    expect(() => resolveHandle("writer", colliding, [])).toThrow(/ambiguous/);
  });

  it("errors when handle not found", () => {
    expect(() => resolveHandle("nobody", peers, [])).toThrow(/no agent/);
  });

  it("errors when scoped peer is unknown", () => {
    expect(() => resolveHandle("carol/writer", peers, [])).toThrow(/unknown peer/);
  });

  it("errors when scoped agent is not in peer's agent list", () => {
    expect(() => resolveHandle("alice/trader", peers, [])).toThrow(/no agent .* on peer/);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run test/peers/resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `src/peers/resolve.ts`:

```ts
import type { PeersConfig } from "../types.js";

export type Scoped = { peer: string | null; agent: string };

export type ResolvedHandle =
  | { kind: "local"; agent: string }
  | { kind: "remote"; peer: string; agent: string };

export function parseScoped(handle: string): Scoped {
  if (!handle) throw new Error("empty handle");
  const parts = handle.split("/");
  if (parts.length === 1) {
    return { peer: null, agent: parts[0] };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid scoped handle: ${handle}`);
  }
  return { peer: parts[0], agent: parts[1] };
}

/**
 * Return the list of handles the adapter should see: bare when globally
 * unique across local + all remote peers, scoped when collisions force it.
 */
export function projectHandles(peers: PeersConfig, localAgents: string[]): string[] {
  const counts = new Map<string, number>();
  for (const a of localAgents) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const peer of Object.values(peers.peers)) {
    for (const a of peer.agents) counts.set(a, (counts.get(a) ?? 0) + 1);
  }

  const out: string[] = [];
  for (const a of localAgents) {
    out.push((counts.get(a) ?? 0) > 1 ? `self/${a}` : a);
  }
  for (const [peerName, peer] of Object.entries(peers.peers)) {
    for (const a of peer.agents) {
      out.push((counts.get(a) ?? 0) > 1 ? `${peerName}/${a}` : a);
    }
  }
  return out;
}

export function resolveHandle(
  handle: string,
  peers: PeersConfig,
  localAgents: string[],
): ResolvedHandle {
  const { peer, agent } = parseScoped(handle);

  if (peer === "self") {
    if (!localAgents.includes(agent)) {
      throw new Error(`no local agent named ${agent}`);
    }
    return { kind: "local", agent };
  }

  if (peer) {
    const entry = peers.peers[peer];
    if (!entry) throw new Error(`unknown peer: ${peer}`);
    if (!entry.agents.includes(agent)) {
      throw new Error(`no agent ${agent} on peer ${peer}`);
    }
    return { kind: "remote", peer, agent };
  }

  const localMatch = localAgents.includes(agent);
  const remoteMatches = Object.entries(peers.peers)
    .filter(([, p]) => p.agents.includes(agent))
    .map(([peerName]) => peerName);

  const totalMatches = (localMatch ? 1 : 0) + remoteMatches.length;
  if (totalMatches === 0) throw new Error(`no agent named ${agent}`);
  if (totalMatches > 1) {
    const options = [
      ...(localMatch ? [`self/${agent}`] : []),
      ...remoteMatches.map((p) => `${p}/${agent}`),
    ];
    throw new Error(`ambiguous: ${options.join(" or ")}`);
  }
  if (localMatch) return { kind: "local", agent };
  return { kind: "remote", peer: remoteMatches[0], agent };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/peers/resolve.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/peers/resolve.ts test/peers/resolve.test.ts
git commit -m "feat(peers): add scoped handle parsing and projection"
```

---

### Task 4: `config-holder.ts` — replace friends/remotes with peers

**Files:**
- Modify: `src/config-holder.ts`
- Modify: `test/config.test.ts` (update affected assertions)

- [ ] **Step 1: Read current config-holder to understand hot-reload polling**

Run: `Read src/config-holder.ts` — note the existing poll interval and file-watch pattern.

- [ ] **Step 2: Write test for peers() accessor and hot-reload**

Append to `test/config.test.ts`:

```ts
import { loadPeersConfig, writePeersConfig } from "../src/peers/config.js";

describe("ConfigHolder — peers hot-reload", () => {
  it("exposes peers() and reflects file changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holder-peers-"));
    await runInit({ configDir: dir });
    // runInit now creates an empty peers.toml
    const holder = createConfigHolder(dir);
    try {
      expect(holder.peers().peers).toEqual({});

      writePeersConfig(path.join(dir, "peers.toml"), {
        peers: {
          alice: {
            fingerprint: "sha256:" + "a".repeat(64),
            endpoint: "https://alice:9900",
            agents: ["writer"],
          },
        },
      });
      await new Promise((r) => setTimeout(r, 700)); // poll interval is 500ms
      expect(holder.peers().peers.alice).toBeDefined();
    } finally {
      holder.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Modify config-holder**

In `src/config-holder.ts`:

- Import `loadPeersConfig` from `./peers/config.js`
- Remove imports of `loadFriendsConfig` / `loadRemotesConfig`
- Replace the `friendsSnapshot` / `remotesSnapshot` state with a `peersSnapshot`
- Replace `friends()` / `remotes()` methods with `peers(): PeersConfig`
- Update the polling loop to re-read `peers.toml` every 500ms
- Keep `server()` accessor as-is

Signature changes:

```ts
export interface ConfigHolder {
  server(): ServerConfig;
  peers(): PeersConfig;
  stop(): void;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-holder.ts test/config.test.ts
git commit -m "feat(config): ConfigHolder exposes peers(), drops friends/remotes"
```

---

### Task 5: `init` writes `peers.toml`, not `friends.toml`/`remotes.toml`

**Files:**
- Modify: `src/cli/init.ts`
- Modify: `test/cli/init.test.ts` if exists, else inline in usage sites

- [ ] **Step 1: Write test**

Create or append to `test/cli/init.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { runInit } from "../../src/cli/init.js";

describe("runInit", () => {
  it("creates peers.toml and does not create friends.toml or remotes.toml", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-"));
    try {
      await runInit({ configDir: dir });
      expect(fs.existsSync(path.join(dir, "peers.toml"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "friends.toml"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "remotes.toml"))).toBe(false);
      const contents = fs.readFileSync(path.join(dir, "peers.toml"), "utf-8");
      // Empty [peers] table or nothing
      expect(contents).toMatch(/^\s*(\[peers\])?\s*$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run test/cli/init.test.ts`
Expected: FAIL — init still writes friends.toml

- [ ] **Step 3: Modify `src/cli/init.ts`**

Remove the code that writes `friends.toml` and `remotes.toml`. Add code that writes an empty `peers.toml` using `writePeersConfig(peersPath, { peers: {} })`.

- [ ] **Step 4: Run test**

Run: `pnpm vitest run test/cli/init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.ts test/cli/init.test.ts
git commit -m "feat(init): write peers.toml; drop friends.toml and remotes.toml"
```

---

### Task 6: `/peers` endpoint returns scoped projection

**Files:**
- Modify: `src/server.ts` (lines 525–541 — the `/peers` handler edited in the earlier patch)
- Create: `test/peers-endpoint-scoped.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/peers-endpoint-scoped.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writePeersConfig } from "../src/peers/config.js";

async function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-scoped-"));
  await runInit({ configDir: dir });
  fs.writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: { port: 0, host: "127.0.0.1", localPort: 0, rateLimit: "1000/hour", streamTimeoutSeconds: 30 },
      agents: { "my-writer": {}, "my-trader": {} },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );
  writePeersConfig(path.join(dir, "peers.toml"), {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["writer", "trader"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer"],
      },
    },
  });
  return dir;
}

describe("GET /.well-known/tidepool/peers (scoped)", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = await setupTmp();
    handle = await startServer({ configDir: dir });
  });
  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns scoped handles only for collisions; bare otherwise", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/tidepool/peers`);
    const body: Array<{ handle: string }> = await res.json();
    const handles = body.map((p) => p.handle).sort();

    expect(handles).toContain("my-writer");   // local, unique
    expect(handles).toContain("my-trader");   // local, unique
    expect(handles).toContain("alice/writer"); // collides with bob/writer
    expect(handles).toContain("bob/writer");   // collides with alice/writer
    expect(handles).toContain("trader");       // alice-only, unique
    expect(handles).not.toContain("writer");   // bare "writer" is ambiguous, must be scoped
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run test/peers-endpoint-scoped.test.ts`
Expected: FAIL — current `/peers` does not scope

- [ ] **Step 3: Update `/peers` handler in `src/server.ts`**

Replace the handler (previously at ~line 525) with:

```ts
app.get("/.well-known/tidepool/peers", (req, res) => {
  const selfRaw = req.query.self;
  const self = typeof selfRaw === "string" ? selfRaw : undefined;

  const cfg = holder.server();
  const localAgents = Object.keys(cfg.agents).filter((a) => a !== self);
  const peersCfg = holder.peers();

  // Add live local sessions so registered-but-yet-to-load agents aren't missing
  for (const sess of sessionRegistry.list()) {
    if (sess.name !== self && !localAgents.includes(sess.name)) localAgents.push(sess.name);
  }

  const handles = projectHandles(peersCfg, localAgents);
  const unique = Array.from(new Set(handles)).sort();
  res.json(unique.map((handle) => ({ handle, did: null as string | null })));
});
```

Add at the top of the file:

```ts
import { projectHandles } from "./peers/resolve.js";
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/peers-endpoint-scoped.test.ts`
Expected: PASS

Also confirm the older test still passes (or update it to match new shape where needed):

Run: `pnpm vitest run test/peers-endpoint.test.ts`
Expected: PASS — the friends-set-only test will need a rewrite using `peers.toml`. Update that file to write `peers.toml` entries instead of `friends.toml`, asserting the same result shape.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/peers-endpoint.test.ts test/peers-endpoint-scoped.test.ts
git commit -m "feat(server): /peers returns minimally-unambiguous scoped projection"
```

---

### Task 7: Middleware — inbound trust via `peers.toml`

**Files:**
- Modify: `src/middleware.ts`
- Modify: `test/middleware.test.ts`

- [ ] **Step 1: Read current middleware to identify the friend-lookup call site**

Run: `Grep "holder\.friends|FriendsConfig|friends\.toml" src/middleware.ts -n`

- [ ] **Step 2: Write failing test for inbound accepted from a peer entry**

Append to `test/middleware.test.ts`:

```ts
describe("middleware — peers-based inbound trust", () => {
  it("accepts an inbound cert matching a peer entry fingerprint", async () => {
    // ... construct a fake ConfigHolder whose peers() returns a peer with the
    // test cert's fingerprint, run the middleware, expect next() to be called.
    // Pattern identical to the old friends-based test, but against peers().
  });

  it("rejects an inbound cert whose fingerprint is not in any peer entry", async () => {
    // ... friends.toml is gone; peers.toml is the only source
  });
});
```

(Copy the exact test harness of the existing friends-based tests in `test/middleware.test.ts` and rewrite it against `peers()`. Do not delete the old tests until this task compiles.)

- [ ] **Step 3: Update middleware**

In `src/middleware.ts`:

- Find every call to `holder.friends()` or `FriendsConfig` use.
- Replace the friend-lookup with a peers-lookup: iterate `peers.peers` and match by fingerprint (or later, DID).
- On match, resolve the inbound's canonical peer handle to the peer's table key.

```ts
function findPeerByFingerprint(
  peers: PeersConfig,
  fingerprint: string,
): { handle: string; entry: PeerEntry } | null {
  for (const [handle, entry] of Object.entries(peers.peers)) {
    if (entry.fingerprint && entry.fingerprint.toLowerCase() === fingerprint.toLowerCase()) {
      return { handle, entry };
    }
  }
  return null;
}
```

Wire `findPeerByFingerprint` into the existing middleware where the old friend lookup lived; reject if not found (unless the connection-request path — see Task 9).

- [ ] **Step 4: Delete the old friends-based tests that no longer apply**

Remove blocks in `test/middleware.test.ts` that assert against `holder.friends()`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/middleware.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/middleware.ts test/middleware.test.ts
git commit -m "feat(middleware): inbound trust lookup via peers.toml"
```

---

### Task 8: Outbound routing via `peers.toml`

**Files:**
- Modify: `src/proxy.ts` (outbound remote routing)
- Modify: `src/outbound-tls.ts` (pinning)
- Modify: `test/proxy.test.ts`

- [ ] **Step 1: Locate the call site where outbound target is resolved**

Run: `Grep "remoteEndpoint|RemoteAgent|remotes\." src/proxy.ts src/outbound-tls.ts -n`

- [ ] **Step 2: Write failing test**

Append to `test/proxy.test.ts`:

```ts
it("routes to a peer's endpoint when the scoped handle matches", async () => {
  // Construct a holder with peers()->{bob: {endpoint, fingerprint, agents: ['writer']}}
  // Send a message addressed to "bob/writer"; assert proxy calls outbound-tls
  // with bob's endpoint and pins bob's fingerprint.
});

it("rejects a scoped handle whose peer is unknown", async () => {
  // Send "carol/writer" → expect 404 peer_not_found
});
```

- [ ] **Step 3: Update `src/proxy.ts` to resolve targets via peers**

Replace any use of `loadRemotesConfig` / `RemoteAgent` with `holder.peers()` and `resolveHandle(handle, peers, localAgents)`. For `{kind: 'remote', peer, agent}` results:

- Look up `peers.peers[peer]`
- Use `entry.endpoint` as the base URL, `agent` as the tenant path
- Pin mTLS via `entry.fingerprint`

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/proxy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/outbound-tls.ts test/proxy.test.ts
git commit -m "feat(proxy): outbound routing resolves via peers.toml"
```

---

### Task 9: Handshake persists into `peers.toml`

**Files:**
- Modify: `src/handshake.ts`
- Modify: `test/handshake.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/handshake.test.ts`:

```ts
it("persists accepted CONNECTION_REQUEST into peers.toml", async () => {
  // Call handshake flow with a stranger cert and mode="auto".
  // Expect writePeersConfig to have been called with a new peer entry
  // containing the stranger's fingerprint and endpoint.
});

it("does not duplicate an existing peer entry", async () => {
  // Existing peer with same fingerprint → no duplicate write
});
```

- [ ] **Step 2: Update `handleConnectionRequest` in `src/handshake.ts`**

Change the signature:

```ts
interface HandleConnectionRequestOpts {
  config: ConnectionRequestConfig;
  peers: PeersConfig;                              // was: friends
  writePeers: (cfg: PeersConfig) => void;          // was: a friends-writer
  peersPath: string;
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  endpoint: string;                                 // new: where to reach them
  fetchAgentCard: (url: string) => Promise<{ name: string }>;
  evaluateWithLLM?: (...) => Promise<{ decision: "accept" | "deny"; reason?: string }>;
  pendingRequestsPath?: string;
}
```

On accept, instead of writing `friends.toml`, write a new peer entry:

```ts
if (!findPeerByFingerprint(opts.peers, opts.fingerprint)) {
  const handle = deriveHandleFromAgentCard(agentCard); // fallback to truncated fingerprint
  opts.peers.peers[handle] = {
    fingerprint: opts.fingerprint,
    endpoint: opts.endpoint,
    agents: [agentCard.name],
  };
  opts.writePeers(opts.peers);
}
```

- [ ] **Step 3: Implement `deriveHandleFromAgentCard`**

In `src/handshake.ts`:

```ts
function deriveHandleFromAgentCard(card: { name: string }, fingerprint: string): string {
  // Placeholder: strip non-alphanumerics, fall back to first 8 hex of fp
  const safe = (card.name || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (safe) return safe;
  return fingerprint.replace("sha256:", "").slice(0, 8);
}
```

- [ ] **Step 4: Update all call sites** (search for `handleConnectionRequest(`)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/handshake.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/handshake.ts test/handshake.test.ts
git commit -m "feat(handshake): persist accepted CONNECTION_REQUESTs into peers.toml"
```

---

### Task 10: CLI — `tidepool agent add`

**Files:**
- Create: `src/cli/agent.ts`
- Create: `test/cli/agent.test.ts`
- Modify: `src/bin/cli.ts`

- [ ] **Step 1: Write failing tests for `runAgentAdd`**

Create `test/cli/agent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runAgentAdd } from "../../src/cli/agent.js";
import { runInit } from "../../src/cli/init.js";
import { loadPeersConfig } from "../../src/peers/config.js";

describe("runAgentAdd", () => {
  let dir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-add-"));
    await runInit({ configDir: dir });
    server = http.createServer((req, res) => {
      if (req.url === "/writer/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "writer", description: "Writes things" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("adds a new peer + agent", async () => {
    await runAgentAdd({
      configDir: dir,
      endpoint: `http://127.0.0.1:${port}`,
      agent: "writer",
      fingerprint: "sha256:" + "a".repeat(64),
      confirm: () => Promise.resolve(true),
    });
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    const peer = cfg.peers["writer"];
    expect(peer).toBeDefined();
    expect(peer.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(peer.agents).toContain("writer");
  });

  it("appends an agent to an existing peer", async () => {
    // Seed: peer "alice" already exists with one agent
    const initialCfg = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: `http://127.0.0.1:${port}`,
          agents: ["old-agent"],
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, "peers.toml"),
      require("@iarna/toml").stringify(initialCfg),
    );

    await runAgentAdd({
      configDir: dir,
      endpoint: `http://127.0.0.1:${port}`,
      agent: "writer",
      fingerprint: "sha256:" + "a".repeat(64),
      confirm: () => Promise.resolve(true),
    });

    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(cfg.peers.alice.agents.sort()).toEqual(["old-agent", "writer"]);
  });

  it("rejects when confirm returns false", async () => {
    await expect(
      runAgentAdd({
        configDir: dir,
        endpoint: `http://127.0.0.1:${port}`,
        agent: "writer",
        fingerprint: "sha256:" + "a".repeat(64),
        confirm: () => Promise.resolve(false),
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it("requires --alias when peer handle would collide", async () => {
    // existing peer "writer" with different fingerprint
    const initialCfg = {
      peers: {
        writer: {
          fingerprint: "sha256:" + "c".repeat(64),
          endpoint: "https://elsewhere:9900",
          agents: ["different-agent"],
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, "peers.toml"),
      require("@iarna/toml").stringify(initialCfg),
    );

    await expect(
      runAgentAdd({
        configDir: dir,
        endpoint: `http://127.0.0.1:${port}`,
        agent: "writer",
        fingerprint: "sha256:" + "a".repeat(64),
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/alias/i);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run test/cli/agent.test.ts`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/cli/agent.ts`**

```ts
import path from "node:path";
import { loadPeersConfig, writePeersConfig } from "../peers/config.js";
import { fetchRemoteAgentCard } from "../agent-card.js";
import type { PeerEntry, PeersConfig } from "../types.js";

function peersPath(configDir: string): string {
  return path.join(configDir, "peers.toml");
}

export interface AgentAddOpts {
  configDir: string;
  endpoint: string;
  agent: string;
  fingerprint?: string;      // TOFU'd if absent (stub for now; require when offline resolution unimplemented)
  did?: string;              // nullable today
  alias?: string;            // if peer handle collides
  confirm: (prompt: { endpoint: string; fingerprint: string; agent: string }) => Promise<boolean>;
}

export async function runAgentAdd(opts: AgentAddOpts): Promise<void> {
  const cardUrl = `${opts.endpoint.replace(/\/+$/, "")}/${opts.agent}/.well-known/agent-card.json`;
  const card = await fetchRemoteAgentCard(cardUrl);
  if (!card) throw new Error(`failed to fetch agent card at ${cardUrl}`);

  // Trust anchor: today require fingerprint; later resolve via DID
  const fingerprint = opts.fingerprint;
  if (!fingerprint) {
    throw new Error("--fingerprint required (DID-based TOFU not yet implemented)");
  }

  const ok = await opts.confirm({ endpoint: opts.endpoint, fingerprint, agent: opts.agent });
  if (!ok) throw new Error("aborted by user");

  const cfg = loadPeersConfig(peersPath(opts.configDir));

  // Find existing peer by fingerprint
  const existingHandle = Object.entries(cfg.peers).find(
    ([, e]) => e.fingerprint?.toLowerCase() === fingerprint.toLowerCase(),
  )?.[0];

  const advertisedHandle = card.name || deriveFallbackHandle(fingerprint);
  const desiredHandle = opts.alias ?? existingHandle ?? advertisedHandle;

  if (!existingHandle && cfg.peers[desiredHandle]) {
    throw new Error(
      `peer handle "${desiredHandle}" already exists with a different fingerprint; pass --alias <new-handle>`,
    );
  }

  if (existingHandle) {
    const entry = cfg.peers[existingHandle];
    if (!entry.agents.includes(opts.agent)) entry.agents.push(opts.agent);
  } else {
    const newEntry: PeerEntry = {
      fingerprint,
      endpoint: opts.endpoint,
      agents: [opts.agent],
    };
    if (opts.did) newEntry.did = opts.did;
    cfg.peers[desiredHandle] = newEntry;
  }

  writePeersConfig(peersPath(opts.configDir), cfg);
}

function deriveFallbackHandle(fingerprint: string): string {
  return "peer-" + fingerprint.replace("sha256:", "").slice(0, 8);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/cli/agent.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent.ts test/cli/agent.test.ts
git commit -m "feat(cli): add 'tidepool agent add' — unified peer+agent registration"
```

---

### Task 11: CLI — `agent ls`, `agent rm`, `agent refresh`

**Files:**
- Modify: `src/cli/agent.ts`
- Modify: `test/cli/agent.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/cli/agent.test.ts`:

```ts
import { runAgentList, runAgentRemove, runAgentRefresh } from "../../src/cli/agent.js";

describe("runAgentList", () => {
  it("returns the minimally-unambiguous projection", async () => {
    // Seed two peers with colliding "writer" agents
    // Expect output to contain "alice/writer" + "bob/writer", no bare "writer"
  });
});

describe("runAgentRemove", () => {
  it("removes an agent from its peer; removes peer if no agents left", async () => {
    // Seed peer "alice" with agents ["writer", "trader"]
    // runAgentRemove({ handle: "alice/writer" })
    // Expect agents === ["trader"]
    // Then runAgentRemove({ handle: "alice/trader" })
    // Expect peer "alice" is gone
  });

  it("errors on unknown handle", async () => {
    await expect(
      runAgentRemove({ configDir: dir, handle: "nobody" }),
    ).rejects.toThrow();
  });
});

describe("runAgentRefresh", () => {
  it("updates a peer's agents list from live card fetch", async () => {
    // Seed peer "bob" with agents=["writer"]; live card advertises ["writer","trader"]
    // Expect after refresh: agents === ["writer","trader"]
  });
});
```

(Flesh out each test with concrete setup similar to Task 10.)

- [ ] **Step 2: Implement the three functions in `src/cli/agent.ts`**

```ts
export async function runAgentList(opts: { configDir: string; localAgents: string[] }): Promise<string[]> {
  const cfg = loadPeersConfig(peersPath(opts.configDir));
  const { projectHandles } = await import("../peers/resolve.js");
  return Array.from(new Set(projectHandles(cfg, opts.localAgents))).sort();
}

export async function runAgentRemove(opts: { configDir: string; handle: string }): Promise<void> {
  const { parseScoped } = await import("../peers/resolve.js");
  const { peer, agent } = parseScoped(opts.handle);
  if (!peer) throw new Error(`must be scoped: ${opts.handle}`);
  const cfg = loadPeersConfig(peersPath(opts.configDir));
  const entry = cfg.peers[peer];
  if (!entry) throw new Error(`unknown peer: ${peer}`);
  entry.agents = entry.agents.filter((a) => a !== agent);
  if (entry.agents.length === 0) delete cfg.peers[peer];
  writePeersConfig(peersPath(opts.configDir), cfg);
}

export async function runAgentRefresh(opts: { configDir: string; peer: string }): Promise<{ added: string[]; removed: string[] }> {
  const cfg = loadPeersConfig(peersPath(opts.configDir));
  const entry = cfg.peers[opts.peer];
  if (!entry) throw new Error(`unknown peer: ${opts.peer}`);

  // Fetch root card to list peer's agents
  const rootCardUrl = `${entry.endpoint.replace(/\/+$/, "")}/.well-known/agent-card.json`;
  const card = await fetchRemoteAgentCard(rootCardUrl);
  if (!card) throw new Error(`failed to fetch ${rootCardUrl}`);
  const advertised = (card.skills ?? []).map((s) => s.name);

  const added = advertised.filter((a) => !entry.agents.includes(a));
  const removed = entry.agents.filter((a) => !advertised.includes(a));

  // For now: add discovered agents, keep locally-known ones even if missing (per "stale, don't prune")
  entry.agents = Array.from(new Set([...entry.agents, ...advertised]));

  writePeersConfig(peersPath(opts.configDir), cfg);
  return { added, removed };
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run test/cli/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/agent.ts test/cli/agent.test.ts
git commit -m "feat(cli): add 'tidepool agent ls/rm/refresh'"
```

---

### Task 12: Wire `agent` command into `src/bin/cli.ts`, drop `friend` + `remote`

**Files:**
- Modify: `src/bin/cli.ts`
- Delete: `src/cli/friend.ts`, `src/cli/remote.ts`, `src/cli/remotes-config.ts`
- Delete: any tests covering `friend` or `remote` CLI specifically

- [ ] **Step 1: Remove `friend` + `remote` command registrations**

In `src/bin/cli.ts`, delete the `program.command("friend")...` and `program.command("remote")...` blocks. Remove their imports.

- [ ] **Step 2: Wire `agent` command**

Add:

```ts
import {
  runAgentAdd,
  runAgentList,
  runAgentRemove,
  runAgentRefresh,
} from "../cli/agent.js";
import readline from "node:readline";

const agent = program.command("agent").description("Manage remote agents");

agent
  .command("add <endpoint> <name>")
  .description("Add a remote peer's agent")
  .option("--fingerprint <sha256>", "Pin cert fingerprint (required until DIDs land)")
  .option("--alias <handle>", "Local peer handle if auto-derivation collides")
  .action(async (endpoint: string, name: string, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    await runAgentAdd({
      configDir,
      endpoint,
      agent: name,
      fingerprint: cmdOpts.fingerprint,
      alias: cmdOpts.alias,
      confirm: async ({ fingerprint, endpoint, agent }) => {
        if (!process.stdin.isTTY) return true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((r) => rl.question(
          `Add agent ${agent} at ${endpoint} (fingerprint ${fingerprint})? [y/N] `, r,
        ));
        rl.close();
        return /^y/i.test(answer);
      },
    });
    ok(`added ${name}`);
  });

agent
  .command("ls")
  .description("List agents in my local namespace")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const server = loadServerConfig(path.join(configDir, "server.toml"));
    const handles = await runAgentList({ configDir, localAgents: Object.keys(server.agents) });
    for (const h of handles) process.stdout.write(h + "\n");
  });

agent
  .command("rm <handle>")
  .description("Remove a remote agent (scoped: peer/agent)")
  .action(async (handle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runAgentRemove({ configDir, handle });
    ok(`removed ${handle}`);
  });

agent
  .command("refresh <peer>")
  .description("Re-fetch a peer's agent card and update their agent list")
  .action(async (peer: string) => {
    const configDir = resolveConfigDir(program.opts());
    const { added, removed } = await runAgentRefresh({ configDir, peer });
    ok(`refreshed ${peer}: +${added.join(",")} -${removed.join(",")}`);
  });
```

- [ ] **Step 3: Delete now-dead modules**

```bash
rm src/cli/friend.ts src/cli/remote.ts src/cli/remotes-config.ts
```

- [ ] **Step 4: Delete their tests**

```bash
# Search first to be sure these are the only ones
ls test/cli/friend*.test.ts test/cli/remote*.test.ts test/friends.test.ts 2>/dev/null
rm -f test/cli/friend*.test.ts test/cli/remote*.test.ts test/friends.test.ts
```

- [ ] **Step 5: Run the full test suite**

Run: `pnpm -w test`
Expected: PASS — adjust imports and fix any stragglers referencing the deleted modules.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): wire 'agent' command; remove 'friend' and 'remote'"
```

---

### Task 13: `tidepool status` shows peers

**Files:**
- Modify: `src/cli/status.ts`
- Modify: `test/cli/status.test.ts`

- [ ] **Step 1: Update test expectations**

In `test/cli/status.test.ts`, replace assertions like `expect(out).toMatch(/friends/)` with `expect(out).toMatch(/Peers \(\d+\)/)`.

- [ ] **Step 2: Update status renderer**

In `src/cli/status.ts`, replace the friends block with:

```ts
const peersCfg = loadPeersConfig(path.join(configDir, "peers.toml"));
const peers = Object.entries(peersCfg.peers);
lines.push(`Peers (${peers.length})`);
for (const [handle, entry] of peers) {
  lines.push(`  ${handle}  (${entry.agents.length} agents)  ${entry.endpoint}`);
  for (const a of entry.agents) lines.push(`    - ${a}`);
}
```

Delete the `0 friends` output.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run test/cli/status.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/status.ts test/cli/status.test.ts
git commit -m "feat(status): show peers instead of friends"
```

---

### Task 14: Adapter — handle scoped handles in `send`

**Files:**
- Modify: `adapters/claude-code/src/outbound.ts`
- Modify: `adapters/claude-code/src/channel.ts`
- Modify: `adapters/claude-code/test/outbound.test.ts`

- [ ] **Step 1: Write failing test**

Append to `adapters/claude-code/test/outbound.test.ts`:

```ts
it("POSTs to /peer/agent/message:send for scoped handles", async () => {
  let receivedPath = "";
  const server = http.createServer((req, res) => {
    receivedPath = req.url ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageId: "ok" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await sendOutbound({
      peer: "bob/writer",
      contextId: "ctx-1",
      text: "hi",
      self: "quail",
      deps: { localPort: port, host: "127.0.0.1" },
    });
    expect(receivedPath).toBe("/bob/writer/message:send");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("POSTs to /<bare>/message:send for bare handles", async () => {
  // ... expect receivedPath === "/writer/message:send"
});
```

- [ ] **Step 2: Update `sendOutbound` URL construction**

In `adapters/claude-code/src/outbound.ts`, replace:

```ts
const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;
```

with:

```ts
const segments = peer.split("/").map(encodeURIComponent);
if (segments.length > 2 || segments.some((s) => !s)) {
  throw new SendError("other", "invalid peer handle shape", peer);
}
const url = `http://${host}:${deps.localPort}/${segments.join("/")}/message:send`;
```

- [ ] **Step 3: Update the daemon-side local router**

In `src/server.ts`, add a route for scoped sends alongside the existing `/:tenant/:action`:

```ts
app.post("/:peer/:agent/:action", async (req, res) => {
  // Delegate to the same handler as /:tenant/:action but with resolved scoped
  // route: { kind: 'remote', peer: req.params.peer, agent: req.params.agent }
});
```

For local `/<bare>/:action`, continue to route through `resolveHandle` — bare handles may map to local agents or remote peers' unique agents.

- [ ] **Step 4: Run tests**

Run: `pnpm -F @jellypod/tidepool-claude-code test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code/src/outbound.ts adapters/claude-code/test/outbound.test.ts src/server.ts
git commit -m "feat(adapter): send supports scoped peer/agent handles"
```

---

### Task 15: Amend design principle in CLAUDE.md and architecture docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Amend `CLAUDE.md` principle §2**

Replace:

```
2. **Locality is opaque to agents.** Adapters receive peer *handles*; only the daemon knows whether a handle is local or remote. Never leak local-vs-remote through the adapter surface.
```

with:

```
2. **Network topology is opaque; peer identity is visible via scoped handles.** Adapters receive handles that are bare when globally unique and peer-scoped (`bob/writer`) when they collide. The daemon resolves handles to endpoints. Agents never see IPs, ports, or whether a peer is on the same daemon — they see *whose* agent, not *where* it runs.
```

- [ ] **Step 2: Update `docs/architecture.md`**

- §1 invariants: update the "opaque handles" line to match the new wording.
- §5 state table: replace `friends.toml` + `remotes.toml` rows with a single `peers.toml` row.
- §6 protocol: update the `/peers` row to note minimally-unambiguous projection + scoped addressing in `/peer/agent/:action`.
- §7 adapter: note the new `send` URL shape.

- [ ] **Step 3: Update `README.md`**

Replace the "Friend each other" + "Remotes" sections with a "Add an agent" section:

```markdown
### Add one of Bob's agents

Once Bob is running `tidepool start` and has registered his `rust-expert`
agent, Alice adds it:

```bash
tidepool agent add https://bob.example:9900 rust-expert \
  --fingerprint sha256:d4e5f6...
```

Alice now has `rust-expert` in her local namespace. The peer entry is
written to `peers.toml`; trust goes both directions on first successful
exchange.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md README.md
git commit -m "docs: amend locality-opacity principle; document peer model"
```

---

### Task 16: Final verification

**Files:** none

- [ ] **Step 1: Full test run**

Run: `pnpm typecheck && pnpm -w test`
Expected: PASS (all tests green, no TS errors)

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: clean exit.

- [ ] **Step 3: Smoke test**

Run: `pnpm smoke`
Expected: passes end-to-end with the new peers-based config.

- [ ] **Step 4: Manual sanity pass**

Start two daemons (different `TIDEPOOL_HOME` dirs), register one agent each, `tidepool agent add` across them, exchange a message, confirm both `peers.toml` files end up with one peer entry each.

- [ ] **Step 5: Final commit (if any stragglers surfaced)**

```bash
git add -A
git commit -m "chore: close out unified-peers rollout"
```

---

## Self-review

- **Spec coverage:**
  - Unified `peers.toml` ✓ (Tasks 1, 2)
  - Drop `friends.toml` + `remotes.toml` ✓ (Tasks 5, 12)
  - Agent-centric CLI ✓ (Tasks 10, 11, 12)
  - Peer-scoped namespace with projection ✓ (Tasks 3, 6, 14)
  - Asymmetric trust + handshake persists ✓ (Task 9)
  - Bidirectional trust on add ✓ (Task 7, 10 — peer entry used for both directions)
  - Design principle amendment ✓ (Task 15)
  - No migration ✓ (Task 5 just writes empty file)
  - DID-ready shape ✓ (Task 1 — schema has `did` field nullable)
  - Dashboard updates — not explicitly covered. Dashboard currently reads `holder.friends()` and needs migration to `holder.peers()`. **Add as Task 14.5 if the dashboard pages break at Task 4** — verify during Task 4 smoke-run and inline-fix if needed.

- **Placeholder scan:** no `TBD`, no `implement later`, no "similar to". One test case in Task 11 says "(Flesh out each test with concrete setup similar to Task 10)" — replace with explicit test bodies during execution; Task 10's test fixture setup can be copied verbatim.

- **Type consistency:**
  - `PeerEntry` defined in Task 1, used in Tasks 7, 9, 10.
  - `ResolvedHandle` discriminated union defined in Task 3, used in Task 8.
  - `PeersConfig` used across all tasks.
  - Functions: `parseScoped`, `projectHandles`, `resolveHandle` all consistent.

Gap noted: dashboard touch is not a dedicated task. During Task 4 when `holder.friends()` disappears, the dashboard will fail to compile; fix inline there and commit as part of Task 4, or split into a separate Task 4.5 if the fix is larger than expected.
