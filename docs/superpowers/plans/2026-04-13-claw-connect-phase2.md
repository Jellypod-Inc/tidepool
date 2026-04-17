# Tidepool Phase 2: Friends and Handshake

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can request, approve, and remove friends. Unknown agents are rejected. Friends get through. The connection handshake (CONNECTION_REQUEST extension) allows strangers to become friends via three modes: accept, deny, and auto (LLM-evaluated).

**Architecture:** Phase 2 builds on the Phase 1 transparent A2A proxy. It adds real fingerprint verification on every inbound request (extracting certs from the TLS handshake and checking against `friends.toml`), a connection handshake flow that lets unknown agents request friendship, and CLI commands for managing friends and connections. The "auto" mode uses the Vercel AI SDK (`generateText`) to evaluate connection requests against a user-defined policy.

**Tech Stack:** Everything from Phase 1 (Node.js, TypeScript, Express, `@iarna/toml`, `node-forge`, `commander`, `vitest`) plus `ai` (Vercel AI SDK) for auto mode LLM evaluation.

**Spec:** `docs/superpowers/specs/2026-04-13-tidepool-revised-design.md`

---

## File Structure

```
tidepool/
├── src/
│   ├── types.ts                  # MODIFIED — add ConnectionRequestConfig, auto mode types
│   ├── config.ts                 # MODIFIED — parse connectionRequests.auto section
│   ├── middleware.ts              # MODIFIED — add extractFingerprint, isConnectionRequest
│   ├── friends.ts                # NEW — add/remove/list friends, write friends.toml
│   ├── handshake.ts              # NEW — handle CONNECTION_REQUEST, modes, LLM evaluation
│   ├── server.ts                 # MODIFIED — wire handshake into public app middleware
│   └── agent-card.ts             # unchanged
├── bin/
│   └── cli.ts                    # MODIFIED — add friends, connect, requests commands
├── test/
│   ├── friends.test.ts           # NEW — add/remove/list friends
│   ├── handshake.test.ts         # NEW — connection request handling, all three modes
│   ├── middleware.test.ts         # MODIFIED — add fingerprint extraction tests
│   └── e2e-handshake.test.ts     # NEW — full handshake flow between two servers
└── fixtures/
    ├── server.toml               # unchanged
    └── friends.toml              # unchanged
```

---

### Task 1: Extend Types for Connection Requests

**Files:**
- Modify: `tidepool/src/types.ts`

- [ ] **Step 1: Add connection request types**

Open `tidepool/src/types.ts` and add the following types after the existing ones:

```typescript
// --- Add to the end of types.ts ---

export interface ConnectionRequestAutoConfig {
  model: string;
  apiKeyEnv: string;
  policy: string;
}

export interface ConnectionRequestConfig {
  mode: "accept" | "deny" | "auto";
  auto?: ConnectionRequestAutoConfig;
}

export interface ConnectionRequest {
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  receivedAt: Date;
}

export interface PendingRequests {
  requests: ConnectionRequest[];
}
```

Also update the `ServerConfig` interface to use the new `ConnectionRequestConfig`:

Replace:
```typescript
  connectionRequests: {
    mode: "accept" | "deny" | "auto";
  };
```

With:
```typescript
  connectionRequests: ConnectionRequestConfig;
```

- [ ] **Step 2: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors (existing code already uses `connectionRequests.mode` which is still present).

- [ ] **Step 3: Commit**

```bash
git add tidepool/src/types.ts
git commit -m "feat(tidepool): add connection request and auto mode types"
```

---

### Task 2: Config Parsing for Auto Mode

**Files:**
- Modify: `tidepool/src/config.ts`
- Modify: `tidepool/test/config.test.ts`
- Modify: `tidepool/fixtures/server.toml`

- [ ] **Step 1: Add auto mode fixture**

Create `tidepool/fixtures/server-auto.toml`:

```toml
[server]
port = 9900
host = "0.0.0.0"
localPort = 9901
rateLimit = "100/hour"

[agents.rust-expert]
localEndpoint = "http://localhost:18800"
rateLimit = "50/hour"
description = "Expert in Rust and systems programming"

[connectionRequests]
mode = "auto"

[connectionRequests.auto]
provider = "anthropic"
model = "your-model-id"
apiKeyEnv = "YOUR_PROVIDER_API_KEY"
policy = "Accept connections from agents who have a clear reason."

[discovery]
providers = ["static"]
cacheTtlSeconds = 300
```

> **Note on model config:** The `model` field takes the provider's native model ID. The `apiKeyEnv` field names the environment variable holding the key. This is a standalone local CLI tool that calls LLM providers directly via `@ai-sdk/anthropic` (not through a hosted gateway). Users configure their own provider and model.

- [ ] **Step 2: Write the failing test**

Add to `tidepool/test/config.test.ts`:

```typescript
// Add this import at the top alongside existing imports:
// (fixturesDir is already defined)

describe("loadServerConfig — auto mode", () => {
  it("parses connectionRequests.auto config", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server-auto.toml"));

    expect(config.connectionRequests.mode).toBe("auto");
    expect(config.connectionRequests.auto).toBeDefined();
    expect(config.connectionRequests.auto!.model).toBe("your-model-id");
    expect(config.connectionRequests.auto!.apiKeyEnv).toBe("YOUR_PROVIDER_API_KEY");
    expect(config.connectionRequests.auto!.policy).toBe(
      "Accept connections from agents who have a clear reason.",
    );
  });

  it("has no auto config when mode is deny", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server.toml"));
    expect(config.connectionRequests.mode).toBe("deny");
    expect(config.connectionRequests.auto).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/config.test.ts`
Expected: FAIL — auto config is not parsed.

- [ ] **Step 4: Update config.ts to parse auto mode**

In `tidepool/src/config.ts`, update the `loadServerConfig` function. Replace the `connectionRequests` section of the return statement:

Replace:
```typescript
    connectionRequests: {
      mode: (connectionRequests.mode as "accept" | "deny" | "auto") ?? "deny",
    },
```

With:
```typescript
    connectionRequests: {
      mode: (connectionRequests.mode as "accept" | "deny" | "auto") ?? "deny",
      ...(connectionRequests.auto
        ? {
            auto: {
              model: (connectionRequests.auto as Record<string, unknown>).model as string,
              apiKeyEnv: (connectionRequests.auto as Record<string, unknown>).apiKeyEnv as string,
              policy: (connectionRequests.auto as Record<string, unknown>).policy as string,
            },
          }
        : {}),
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/config.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add tidepool/src/config.ts tidepool/test/config.test.ts tidepool/fixtures/server-auto.toml
git commit -m "feat(tidepool): parse connectionRequests.auto config from server.toml"
```

---

### Task 3: Friends Management (add/remove/list + write to disk)

**Files:**
- Create: `tidepool/src/friends.ts`
- Create: `tidepool/test/friends.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/friends.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import TOML from "@iarna/toml";
import {
  addFriend,
  removeFriend,
  listFriends,
  writeFriendsConfig,
} from "../src/friends.js";
import type { FriendsConfig } from "../src/types.js";

describe("friends management", () => {
  let tmpDir: string;
  let friendsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-friends-"));
    friendsPath = path.join(tmpDir, "friends.toml");

    // Seed with one friend
    const initial: FriendsConfig = {
      friends: {
        "alice-agent": {
          fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    };
    fs.writeFileSync(friendsPath, TOML.stringify(initial as any));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe("addFriend", () => {
    it("adds a new friend to the config", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": {
            fingerprint: "sha256:aaaa",
          },
        },
      };

      const updated = addFriend(config, {
        handle: "bob-agent",
        fingerprint: "sha256:bbbb",
      });

      expect(updated.friends["bob-agent"]).toBeDefined();
      expect(updated.friends["bob-agent"].fingerprint).toBe("sha256:bbbb");
      expect(updated.friends["alice-agent"]).toBeDefined();
    });

    it("adds a scoped friend", () => {
      const config: FriendsConfig = { friends: {} };

      const updated = addFriend(config, {
        handle: "carol-ml",
        fingerprint: "sha256:cccc",
        agents: ["rust-expert"],
      });

      expect(updated.friends["carol-ml"].agents).toEqual(["rust-expert"]);
    });

    it("throws if handle already exists", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
        },
      };

      expect(() =>
        addFriend(config, {
          handle: "alice-agent",
          fingerprint: "sha256:different",
        }),
      ).toThrow("already exists");
    });

    it("throws if fingerprint already exists under different handle", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
        },
      };

      expect(() =>
        addFriend(config, {
          handle: "alice-duplicate",
          fingerprint: "sha256:aaaa",
        }),
      ).toThrow("already registered");
    });
  });

  describe("removeFriend", () => {
    it("removes a friend by handle", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
          "bob-agent": { fingerprint: "sha256:bbbb" },
        },
      };

      const updated = removeFriend(config, "alice-agent");

      expect(updated.friends["alice-agent"]).toBeUndefined();
      expect(updated.friends["bob-agent"]).toBeDefined();
    });

    it("throws if handle does not exist", () => {
      const config: FriendsConfig = { friends: {} };

      expect(() => removeFriend(config, "nobody")).toThrow("not found");
    });
  });

  describe("listFriends", () => {
    it("returns all friends as an array of entries", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
          "bob-agent": { fingerprint: "sha256:bbbb", agents: ["rust-expert"] },
        },
      };

      const list = listFriends(config);

      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        handle: "alice-agent",
        fingerprint: "sha256:aaaa",
      });
      expect(list[1]).toEqual({
        handle: "bob-agent",
        fingerprint: "sha256:bbbb",
        agents: ["rust-expert"],
      });
    });
  });

  describe("writeFriendsConfig", () => {
    it("writes friends config to disk as TOML", () => {
      const config: FriendsConfig = {
        friends: {
          "new-friend": { fingerprint: "sha256:1234" },
        },
      };

      writeFriendsConfig(friendsPath, config);

      const content = fs.readFileSync(friendsPath, "utf-8");
      const parsed = TOML.parse(content);
      const friends = parsed.friends as Record<string, Record<string, unknown>>;
      expect(friends["new-friend"].fingerprint).toBe("sha256:1234");
    });

    it("roundtrips correctly with scoped agents", () => {
      const config: FriendsConfig = {
        friends: {
          "scoped-friend": {
            fingerprint: "sha256:5678",
            agents: ["rust-expert", "code-reviewer"],
          },
        },
      };

      writeFriendsConfig(friendsPath, config);

      const content = fs.readFileSync(friendsPath, "utf-8");
      const parsed = TOML.parse(content);
      const friends = parsed.friends as Record<string, Record<string, unknown>>;
      expect(friends["scoped-friend"].agents).toEqual([
        "rust-expert",
        "code-reviewer",
      ]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/friends.test.ts`
Expected: FAIL — `Cannot find module '../src/friends.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/friends.ts`:

```typescript
import fs from "fs";
import TOML from "@iarna/toml";
import type { FriendsConfig, FriendEntry } from "./types.js";

interface AddFriendOpts {
  handle: string;
  fingerprint: string;
  agents?: string[];
}

export function addFriend(
  config: FriendsConfig,
  opts: AddFriendOpts,
): FriendsConfig {
  if (config.friends[opts.handle]) {
    throw new Error(`Friend "${opts.handle}" already exists`);
  }

  // Check for duplicate fingerprint
  for (const [existingHandle, entry] of Object.entries(config.friends)) {
    if (entry.fingerprint === opts.fingerprint) {
      throw new Error(
        `Fingerprint already registered under handle "${existingHandle}"`,
      );
    }
  }

  const newEntry: FriendEntry = {
    fingerprint: opts.fingerprint,
  };
  if (opts.agents && opts.agents.length > 0) {
    newEntry.agents = opts.agents;
  }

  return {
    friends: {
      ...config.friends,
      [opts.handle]: newEntry,
    },
  };
}

export function removeFriend(
  config: FriendsConfig,
  handle: string,
): FriendsConfig {
  if (!config.friends[handle]) {
    throw new Error(`Friend "${handle}" not found`);
  }

  const { [handle]: _, ...rest } = config.friends;
  return { friends: rest };
}

interface FriendListEntry {
  handle: string;
  fingerprint: string;
  agents?: string[];
}

export function listFriends(config: FriendsConfig): FriendListEntry[] {
  return Object.entries(config.friends).map(([handle, entry]) => {
    const result: FriendListEntry = {
      handle,
      fingerprint: entry.fingerprint,
    };
    if (entry.agents) {
      result.agents = entry.agents;
    }
    return result;
  });
}

export function writeFriendsConfig(
  filePath: string,
  config: FriendsConfig,
): void {
  const tomlData: Record<string, unknown> = {
    friends: Object.fromEntries(
      Object.entries(config.friends).map(([handle, entry]) => {
        const value: Record<string, unknown> = {
          fingerprint: entry.fingerprint,
        };
        if (entry.agents) {
          value.agents = entry.agents;
        }
        return [handle, value];
      }),
    ),
  };

  fs.writeFileSync(filePath, TOML.stringify(tomlData as any));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/friends.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/friends.ts tidepool/test/friends.test.ts
git commit -m "feat(tidepool): friends management — add, remove, list, write to disk"
```

---

### Task 4: Middleware — Fingerprint Extraction and Connection Request Detection

**Files:**
- Modify: `tidepool/src/middleware.ts`
- Modify: `tidepool/test/middleware.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tidepool/test/middleware.test.ts`:

```typescript
// Add these imports at the top:
import { extractFingerprint, isConnectionRequest } from "../src/middleware.js";

// Add after the existing describe blocks:

describe("extractFingerprint", () => {
  it("returns fingerprint from a raw cert buffer", () => {
    // Use node-forge to create a test cert and get its DER bytes
    const forge = await import("node-forge");
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: "commonName", value: "test" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const rawBuffer = Buffer.from(der, "binary");

    const fingerprint = extractFingerprint(rawBuffer);
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Verify it matches getFingerprint from identity.ts
    const { getFingerprint } = await import("../src/identity.js");
    expect(fingerprint).toBe(getFingerprint(certPem));
  });

  it("returns null for undefined input", () => {
    const fingerprint = extractFingerprint(undefined);
    expect(fingerprint).toBeNull();
  });

  it("returns null for empty buffer", () => {
    const fingerprint = extractFingerprint(Buffer.alloc(0));
    expect(fingerprint).toBeNull();
  });
});

describe("isConnectionRequest", () => {
  it("returns true for a valid CONNECTION_REQUEST body", () => {
    const body = {
      message: {
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
        extensions: ["https://tidepool.dev/ext/connection/v1"],
        metadata: {
          "https://tidepool.dev/ext/connection/v1": {
            type: "request",
            reason: "Want to learn Rust",
            agent_card_url: "https://example.com/.well-known/agent-card.json",
          },
        },
      },
    };
    expect(isConnectionRequest(body)).toBe(true);
  });

  it("returns false for a normal A2A message", () => {
    const body = {
      message: {
        parts: [{ kind: "text", text: "Hello, how do you handle errors in Rust?" }],
      },
    };
    expect(isConnectionRequest(body)).toBe(false);
  });

  it("returns false for missing extension", () => {
    const body = {
      message: {
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
        // no extensions array
      },
    };
    expect(isConnectionRequest(body)).toBe(false);
  });

  it("returns false for null body", () => {
    expect(isConnectionRequest(null)).toBe(false);
    expect(isConnectionRequest(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/middleware.test.ts`
Expected: FAIL — `extractFingerprint` and `isConnectionRequest` are not exported.

- [ ] **Step 3: Update middleware.ts**

Add to `tidepool/src/middleware.ts`:

```typescript
import forge from "node-forge";

// ... keep existing checkFriend, checkAgentScope, resolveTenant ...

const EXTENSION_URL = "https://tidepool.dev/ext/connection/v1";

/**
 * Extract SHA-256 fingerprint from a raw DER certificate buffer.
 * This is the buffer you get from `socket.getPeerCertificate().raw`.
 */
export function extractFingerprint(raw: Buffer | undefined): string | null {
  if (!raw || raw.length === 0) return null;

  const md = forge.md.sha256.create();
  md.update(raw.toString("binary"));
  return `sha256:${md.digest().toHex()}`;
}

/**
 * Check if an inbound A2A request body is a CONNECTION_REQUEST.
 * Looks for the Tidepool connection extension in the message.
 */
export function isConnectionRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;

  const msg = (body as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return false;

  const message = msg as Record<string, unknown>;
  const extensions = message.extensions as string[] | undefined;
  if (!extensions || !Array.isArray(extensions)) return false;

  if (!extensions.includes(EXTENSION_URL)) return false;

  const parts = message.parts as Array<Record<string, string>> | undefined;
  if (!parts || !Array.isArray(parts) || parts.length === 0) return false;

  return parts[0].text === "CONNECTION_REQUEST";
}

/**
 * Extract connection request metadata from a validated CONNECTION_REQUEST body.
 */
export function extractConnectionMetadata(
  body: Record<string, unknown>,
): { reason: string; agentCardUrl: string } | null {
  const msg = body.message as Record<string, unknown>;
  const metadata = msg.metadata as Record<string, Record<string, string>> | undefined;
  if (!metadata) return null;

  const ext = metadata[EXTENSION_URL];
  if (!ext || ext.type !== "request") return null;

  return {
    reason: ext.reason ?? "",
    agentCardUrl: ext.agent_card_url ?? "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/middleware.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/middleware.ts tidepool/test/middleware.test.ts
git commit -m "feat(tidepool): fingerprint extraction and connection request detection"
```

---

### Task 5: Connection Handshake Handler

**Files:**
- Create: `tidepool/src/handshake.ts`
- Create: `tidepool/test/handshake.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tidepool/test/handshake.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  handleConnectionRequest,
  buildAcceptedResponse,
  buildDeniedResponse,
  deriveHandle,
} from "../src/handshake.js";
import type {
  ConnectionRequestConfig,
  FriendsConfig,
} from "../src/types.js";

describe("buildAcceptedResponse", () => {
  it("returns an A2A task with TASK_STATE_COMPLETED and accepted extension", () => {
    const response = buildAcceptedResponse();

    expect(response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0].parts[0].text).toBe("Connection accepted");
    expect(
      response.artifacts[0].metadata["https://tidepool.dev/ext/connection/v1"]
        .type,
    ).toBe("accepted");
  });
});

describe("buildDeniedResponse", () => {
  it("returns an A2A task with TASK_STATE_REJECTED and denied extension", () => {
    const response = buildDeniedResponse("Not accepting connections");

    expect(response.status.state).toBe("TASK_STATE_REJECTED");
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0].parts[0].text).toBe("Connection denied");
    expect(
      response.artifacts[0].metadata["https://tidepool.dev/ext/connection/v1"]
        .type,
    ).toBe("denied");
    expect(
      response.artifacts[0].metadata["https://tidepool.dev/ext/connection/v1"]
        .reason,
    ).toBe("Not accepting connections");
  });
});

describe("deriveHandle", () => {
  it("uses the agent card name as handle", () => {
    const handle = deriveHandle("alice-dev", {});
    expect(handle).toBe("alice-dev");
  });

  it("appends suffix on collision", () => {
    const existing: FriendsConfig = {
      friends: {
        "alice-dev": { fingerprint: "sha256:aaaa" },
      },
    };
    const handle = deriveHandle("alice-dev", existing);
    expect(handle).toBe("alice-dev-2");
  });

  it("increments suffix on multiple collisions", () => {
    const existing: FriendsConfig = {
      friends: {
        "alice-dev": { fingerprint: "sha256:aaaa" },
        "alice-dev-2": { fingerprint: "sha256:bbbb" },
      },
    };
    const handle = deriveHandle("alice-dev", existing);
    expect(handle).toBe("alice-dev-3");
  });
});

describe("handleConnectionRequest — accept mode", () => {
  it("auto-approves and returns accepted response", async () => {
    const config: ConnectionRequestConfig = { mode: "accept" };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.newFriend).toBeDefined();
    expect(result.newFriend!.handle).toBe("alice-dev");
    expect(result.newFriend!.fingerprint).toBe(
      "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
  });
});

describe("handleConnectionRequest — deny mode", () => {
  it("rejects all connection requests", async () => {
    const config: ConnectionRequestConfig = { mode: "deny" };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_REJECTED");
    expect(result.newFriend).toBeUndefined();
  });
});

describe("handleConnectionRequest — auto mode", () => {
  it("approves when LLM returns accept", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Accept agents with a clear reason.",
      },
    };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reason: "I want to learn Rust error handling patterns",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
      evaluateWithLLM: async () => ({
        decision: "accept" as const,
      }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.newFriend).toBeDefined();
  });

  it("denies when LLM returns deny", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Only accept agents from the acme.com domain.",
      },
    };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert",
      reason: "Random request",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "spammer" }),
      evaluateWithLLM: async () => ({
        decision: "deny" as const,
        reason: "Does not meet policy criteria",
      }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_REJECTED");
    expect(result.newFriend).toBeUndefined();
  });

  it("throws if auto mode configured but no auto config", async () => {
    const config: ConnectionRequestConfig = { mode: "auto" };
    const friends: FriendsConfig = { friends: {} };

    await expect(
      handleConnectionRequest({
        config,
        friends,
        fingerprint: "sha256:newcert",
        reason: "test",
        agentCardUrl: "https://example.com/card.json",
        fetchAgentCard: async () => ({ name: "test" }),
      }),
    ).rejects.toThrow("auto mode requires");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/handshake.test.ts`
Expected: FAIL — `Cannot find module '../src/handshake.js'`

- [ ] **Step 3: Write the implementation**

Create `tidepool/src/handshake.ts`:

```typescript
import { v4 as uuidv4 } from "uuid";
import type {
  ConnectionRequestConfig,
  FriendsConfig,
} from "./types.js";

const EXTENSION_URL = "https://tidepool.dev/ext/connection/v1";

interface ConnectionResponse {
  id: string;
  status: { state: string };
  artifacts: Array<{
    artifactId: string;
    parts: Array<{ kind: string; text: string }>;
    metadata: Record<string, Record<string, string>>;
  }>;
}

interface NewFriend {
  handle: string;
  fingerprint: string;
}

interface HandleConnectionRequestOpts {
  config: ConnectionRequestConfig;
  friends: FriendsConfig;
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  fetchAgentCard: (url: string) => Promise<{ name: string }>;
  evaluateWithLLM?: (opts: {
    reason: string;
    agentCardUrl: string;
    agentName: string;
    policy: string;
  }) => Promise<{ decision: "accept" | "deny"; reason?: string }>;
}

interface HandleConnectionRequestResult {
  response: ConnectionResponse;
  newFriend?: NewFriend;
}

export function buildAcceptedResponse(): ConnectionResponse {
  return {
    id: uuidv4(),
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [
      {
        artifactId: "connection-result",
        parts: [{ kind: "text", text: "Connection accepted" }],
        metadata: {
          [EXTENSION_URL]: {
            type: "accepted",
          },
        },
      },
    ],
  };
}

export function buildDeniedResponse(reason: string): ConnectionResponse {
  return {
    id: uuidv4(),
    status: { state: "TASK_STATE_REJECTED" },
    artifacts: [
      {
        artifactId: "connection-result",
        parts: [{ kind: "text", text: "Connection denied" }],
        metadata: {
          [EXTENSION_URL]: {
            type: "denied",
            reason,
          },
        },
      },
    ],
  };
}

export function deriveHandle(
  name: string,
  existingFriends: FriendsConfig | Record<string, unknown>,
): string {
  const friends =
    "friends" in existingFriends
      ? (existingFriends as FriendsConfig).friends
      : (existingFriends as Record<string, unknown>);

  if (!(name in friends)) return name;

  let suffix = 2;
  while (`${name}-${suffix}` in friends) {
    suffix++;
  }
  return `${name}-${suffix}`;
}

export async function handleConnectionRequest(
  opts: HandleConnectionRequestOpts,
): Promise<HandleConnectionRequestResult> {
  const { config, friends, fingerprint, reason, agentCardUrl } = opts;

  switch (config.mode) {
    case "deny": {
      return {
        response: buildDeniedResponse("Not accepting connections at this time"),
      };
    }

    case "accept": {
      const agentCard = await opts.fetchAgentCard(agentCardUrl);
      const handle = deriveHandle(agentCard.name, friends);

      return {
        response: buildAcceptedResponse(),
        newFriend: { handle, fingerprint },
      };
    }

    case "auto": {
      if (!config.auto) {
        throw new Error(
          "auto mode requires connectionRequests.auto configuration in server.toml",
        );
      }

      const agentCard = await opts.fetchAgentCard(agentCardUrl);

      const evaluate =
        opts.evaluateWithLLM ?? (await createDefaultEvaluator(config));
      const decision = await evaluate({
        reason,
        agentCardUrl,
        agentName: agentCard.name,
        policy: config.auto.policy,
      });

      if (decision.decision === "accept") {
        const handle = deriveHandle(agentCard.name, friends);
        return {
          response: buildAcceptedResponse(),
          newFriend: { handle, fingerprint },
        };
      }

      return {
        response: buildDeniedResponse(
          decision.reason ?? "Connection request denied by policy",
        ),
      };
    }

    default:
      return {
        response: buildDeniedResponse("Unknown connection mode"),
      };
  }
}

async function createDefaultEvaluator(
  config: ConnectionRequestConfig,
): Promise<
  (opts: {
    reason: string;
    agentCardUrl: string;
    agentName: string;
    policy: string;
  }) => Promise<{ decision: "accept" | "deny"; reason?: string }>
> {
  const { generateText } = await import("ai");

  const apiKey = config.auto?.apiKeyEnv
    ? process.env[config.auto.apiKeyEnv]
    : undefined;

  if (!apiKey) {
    throw new Error(
      `Environment variable ${config.auto?.apiKeyEnv} is not set (needed for auto mode)`,
    );
  }

  // Dynamic import of the provider — the model string determines which provider to use.
  // For now, we support anthropic models via @ai-sdk/anthropic.
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey });

  return async (opts) => {
    const result = await generateText({
      model: anthropic(config.auto!.model),
      system: `You are a connection request evaluator for an A2A (agent-to-agent) network.

Your job is to decide whether to accept or deny a connection request based on the server owner's policy.

Policy:
${opts.policy}

Respond with exactly one of these two formats:
ACCEPT
or
DENY: <reason>

Nothing else. No explanation, no markdown, no extra text.`,
      prompt: `Connection request from agent "${opts.agentName}":
Reason: ${opts.reason}
Agent Card URL: ${opts.agentCardUrl}`,
    });

    const text = result.text.trim();

    if (text === "ACCEPT") {
      return { decision: "accept" };
    }

    const denyMatch = text.match(/^DENY:\s*(.+)$/s);
    if (denyMatch) {
      return { decision: "deny", reason: denyMatch[1].trim() };
    }

    // Default to deny if LLM response is unparseable
    return { decision: "deny", reason: "Could not evaluate request" };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/handshake.test.ts`
Expected: 8 tests PASS. (Tests use injected `evaluateWithLLM` mock, so no real API calls.)

- [ ] **Step 5: Commit**

```bash
git add tidepool/src/handshake.ts tidepool/test/handshake.test.ts
git commit -m "feat(tidepool): connection handshake handler with accept, deny, and auto modes"
```

---

### Task 6: Wire Handshake into Server

**Files:**
- Modify: `tidepool/src/server.ts`

This task modifies the public interface middleware in `server.ts` to:
1. Extract cert fingerprints using `extractFingerprint` (replacing the raw PEM approach)
2. Detect CONNECTION_REQUEST messages from non-friends
3. Route them to the handshake handler
4. Write new friends to `friends.toml` on approval

- [ ] **Step 1: Update imports in server.ts**

Add these imports at the top of `tidepool/src/server.ts`:

```typescript
import {
  extractFingerprint,
  isConnectionRequest,
  extractConnectionMetadata,
} from "./middleware.js";
import { handleConnectionRequest } from "./handshake.js";
import { addFriend, writeFriendsConfig } from "./friends.js";
```

- [ ] **Step 2: Update createPublicApp to use extractFingerprint**

In `createPublicApp`, replace the fingerprint extraction block in the `app.post("/:tenant/*", ...)` handler. Find:

```typescript
      // 1. Extract peer cert fingerprint
      const peerCert = (req.socket as any).getPeerCertificate?.();
      if (!peerCert || !peerCert.raw) {
        res.status(401).json({ error: "No client certificate" });
        return;
      }

      const peerFingerprint = getFingerprint(
        `-----BEGIN CERTIFICATE-----\n${peerCert.raw.toString("base64")}\n-----END CERTIFICATE-----`,
      );
```

Replace with:

```typescript
      // 1. Extract peer cert fingerprint
      const peerCert = (req.socket as any).getPeerCertificate?.();
      const peerFingerprint = extractFingerprint(peerCert?.raw);
      if (!peerFingerprint) {
        res.status(401).json({ error: "No client certificate" });
        return;
      }
```

- [ ] **Step 3: Add connection request handling**

In the same handler, replace the non-friend rejection block. Find:

```typescript
      // 2. Check friends list
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        // Phase 2 will add CONNECTION_REQUEST handling here.
        // For now, all non-friends are rejected.
        res.status(401).json({ error: "Not a friend" });
        return;
      }
```

Replace with:

```typescript
      // 2. Check friends list
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        // Not a friend — check if this is a CONNECTION_REQUEST
        if (isConnectionRequest(req.body)) {
          const metadata = extractConnectionMetadata(
            req.body as Record<string, unknown>,
          );
          if (!metadata) {
            res.status(400).json({ error: "Malformed connection request" });
            return;
          }

          try {
            const result = await handleConnectionRequest({
              config: config.connectionRequests,
              friends,
              fingerprint: peerFingerprint,
              reason: metadata.reason,
              agentCardUrl: metadata.agentCardUrl,
              fetchAgentCard: async (url: string) => {
                const resp = await fetch(url);
                const card = await resp.json() as { name: string };
                return { name: card.name };
              },
            });

            // If approved, persist the new friend
            if (result.newFriend) {
              const updated = addFriend(friends, {
                handle: result.newFriend.handle,
                fingerprint: result.newFriend.fingerprint,
              });
              // Mutate the in-memory friends config
              friends.friends = updated.friends;
              // Write to disk
              writeFriendsConfig(`${configDir}/friends.toml`, updated);
            }

            res.json(result.response);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Handshake failed";
            res.status(500).json({ error: message });
          }
          return;
        }

        // Not a friend, not a connection request — reject
        res.status(401).json({ error: "Not a friend" });
        return;
      }
```

- [ ] **Step 4: Update the friends parameter to be mutable**

The `createPublicApp` function receives `friends: FriendsConfig`. Since we mutate `friends.friends` after approving a connection request, the in-memory state stays in sync for subsequent requests without reloading from disk.

No code change needed — the object reference is already mutable. This is intentional: the public app holds a reference to the friends config, and mutation ensures new friends are recognized immediately.

- [ ] **Step 5: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add tidepool/src/server.ts
git commit -m "feat(tidepool): wire connection handshake into public interface middleware"
```

---

### Task 7: CLI — Friends Commands

**Files:**
- Modify: `tidepool/bin/cli.ts`

- [ ] **Step 1: Add friends commands to CLI**

Add the following commands to `tidepool/bin/cli.ts`, after the existing `agents` command and before `start`:

```typescript
// --- Add these imports at the top alongside existing imports ---
import { loadFriendsConfig } from "../src/config.js";
import { addFriend, removeFriend, listFriends, writeFriendsConfig } from "../src/friends.js";

// --- Add these commands ---

const friendsCmd = program
  .command("friends")
  .description("Manage friends list");

friendsCmd
  .command("list")
  .description("List all friends")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);
    const friends = listFriends(config);

    if (friends.length === 0) {
      console.log("No friends yet.");
      return;
    }

    for (const f of friends) {
      const scope = f.agents ? ` (agents: ${f.agents.join(", ")})` : " (all agents)";
      console.log(`  ${f.handle} — ${f.fingerprint}${scope}`);
    }
  });

friendsCmd
  .command("add")
  .description("Add a friend manually")
  .requiredOption("--handle <handle>", "Local handle for the friend")
  .requiredOption("--fingerprint <fingerprint>", "Friend's cert fingerprint (sha256:...)")
  .option("--agents <agents...>", "Scope to specific agents")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);

    try {
      const updated = addFriend(config, {
        handle: opts.handle,
        fingerprint: opts.fingerprint,
        agents: opts.agents,
      });

      writeFriendsConfig(friendsPath, updated);
      const scope = opts.agents ? ` (agents: ${opts.agents.join(", ")})` : " (all agents)";
      console.log(`Added friend "${opts.handle}" — ${opts.fingerprint}${scope}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to add friend");
      process.exit(1);
    }
  });

friendsCmd
  .command("remove")
  .description("Remove a friend")
  .argument("<handle>", "Handle of the friend to remove")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((handle, opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);

    try {
      const updated = removeFriend(config, handle);
      writeFriendsConfig(friendsPath, updated);
      console.log(`Removed friend "${handle}"`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to remove friend");
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Make bare `tidepool friends` show the list**

To make `tidepool friends` (without subcommand) default to listing, add this after creating the `friendsCmd`:

```typescript
// Default action for bare "friends" command (no subcommand)
friendsCmd
  .action((opts) => {
    const friendsPath = path.join(opts.dir ?? DEFAULT_CONFIG_DIR, "friends.toml");
    const config = loadFriendsConfig(friendsPath);
    const friends = listFriends(config);

    if (friends.length === 0) {
      console.log("No friends yet.");
      return;
    }

    for (const f of friends) {
      const scope = f.agents ? ` (agents: ${f.agents.join(", ")})` : " (all agents)";
      console.log(`  ${f.handle} — ${f.fingerprint}${scope}`);
    }
  })
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR);
```

- [ ] **Step 3: Test CLI manually**

Run:
```bash
cd tidepool

# Setup
npx tsx bin/cli.ts init --dir /tmp/cc-friends-test

# Add friends
npx tsx bin/cli.ts friends add --handle alice --fingerprint "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" --dir /tmp/cc-friends-test
npx tsx bin/cli.ts friends add --handle bob --fingerprint "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" --agents rust-expert --dir /tmp/cc-friends-test

# List
npx tsx bin/cli.ts friends list --dir /tmp/cc-friends-test
npx tsx bin/cli.ts friends --dir /tmp/cc-friends-test

# Remove
npx tsx bin/cli.ts friends remove alice --dir /tmp/cc-friends-test
npx tsx bin/cli.ts friends list --dir /tmp/cc-friends-test
```

Expected:
```
Added friend "alice" — sha256:aaaa... (all agents)
Added friend "bob" — sha256:bbbb... (agents: rust-expert)
  alice — sha256:aaaa... (all agents)
  bob — sha256:bbbb... (agents: rust-expert)
Removed friend "alice"
  bob — sha256:bbbb... (agents: rust-expert)
```

- [ ] **Step 4: Cleanup and commit**

```bash
rm -rf /tmp/cc-friends-test
git add tidepool/bin/cli.ts
git commit -m "feat(tidepool): CLI friends add/remove/list commands"
```

---

### Task 8: CLI — Connect and Requests Commands

**Files:**
- Modify: `tidepool/bin/cli.ts`

- [ ] **Step 1: Add the connect command**

Add to `tidepool/bin/cli.ts`:

```typescript
// --- Add these imports at the top ---
import { getFingerprint } from "../src/identity.js";
import { Agent as UndiciAgent } from "undici";

program
  .command("connect")
  .description("Send a connection request to a remote agent")
  .argument("<agent-card-url>", "URL of the remote agent's Agent Card")
  .requiredOption("--as <agent>", "Which local agent identity to use for the request")
  .option("--reason <reason>", "Reason for connecting", "Would like to connect")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (agentCardUrl, opts) => {
    const configDir = opts.dir;
    const agentName = opts.as;
    const reason = opts.reason;

    // Load local agent's cert for mTLS
    const certPath = path.join(configDir, "agents", agentName, "identity.crt");
    const keyPath = path.join(configDir, "agents", agentName, "identity.key");

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`Agent "${agentName}" not found. Run 'tidepool register' first.`);
      process.exit(1);
    }

    // Fetch the remote agent card to get the endpoint
    console.log(`Fetching agent card from ${agentCardUrl}...`);
    let remoteCard: { name: string; url: string };
    try {
      const cardResp = await fetch(agentCardUrl);
      remoteCard = (await cardResp.json()) as { name: string; url: string };
    } catch (err) {
      console.error(`Failed to fetch agent card: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    console.log(`Remote agent: ${remoteCard.name} at ${remoteCard.url}`);

    // Build the connection request
    const messageUrl = `${remoteCard.url}/message:send`;
    const body = {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
        extensions: ["https://tidepool.dev/ext/connection/v1"],
        metadata: {
          "https://tidepool.dev/ext/connection/v1": {
            type: "request",
            reason,
            agent_card_url: agentCardUrl,
          },
        },
      },
    };

    console.log(`Sending connection request to ${messageUrl}...`);

    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);

      const response = await fetch(messageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher: new UndiciAgent({
          connect: { cert, key, rejectUnauthorized: false },
        }),
      });

      const result = (await response.json()) as Record<string, unknown>;

      const status = result.status as { state: string } | undefined;
      if (status?.state === "TASK_STATE_COMPLETED") {
        console.log("Connection accepted!");
        console.log(`Remote agent "${remoteCard.name}" is now a friend on their server.`);
        console.log(`\nTo add them as a friend on YOUR server, run:`);

        // Read the remote server's cert fingerprint from the TLS connection
        // For now, prompt the user to add manually
        console.log(
          `  tidepool friends add --handle "${remoteCard.name}" --fingerprint <their-fingerprint>`,
        );
      } else if (status?.state === "TASK_STATE_REJECTED") {
        const artifacts = result.artifacts as Array<{
          metadata?: Record<string, Record<string, string>>;
        }>;
        const ext =
          artifacts?.[0]?.metadata?.["https://tidepool.dev/ext/connection/v1"];
        const denyReason = ext?.reason ?? "No reason given";
        console.log(`Connection denied: ${denyReason}`);
      } else {
        console.log("Unexpected response:", JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(
        `Connection request failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Add the requests command**

Add to `tidepool/bin/cli.ts`:

```typescript
program
  .command("requests")
  .description("View pending inbound connection requests (mode=deny only)")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const pendingPath = path.join(opts.dir, "pending-requests.json");

    if (!fs.existsSync(pendingPath)) {
      console.log("No pending connection requests.");
      return;
    }

    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as {
      requests: Array<{
        fingerprint: string;
        reason: string;
        agentCardUrl: string;
        receivedAt: string;
      }>;
    };

    if (pending.requests.length === 0) {
      console.log("No pending connection requests.");
      return;
    }

    console.log(`${pending.requests.length} pending request(s):\n`);
    for (const req of pending.requests) {
      console.log(`  Fingerprint: ${req.fingerprint}`);
      console.log(`  Reason:      ${req.reason}`);
      console.log(`  Agent Card:  ${req.agentCardUrl}`);
      console.log(`  Received:    ${req.receivedAt}`);
      console.log();
    }

    console.log("To approve, run:");
    console.log('  tidepool friends add --handle "<name>" --fingerprint "<fingerprint>"');
  });
```

- [ ] **Step 3: Test connect command manually (optional — requires running servers)**

This is validated more thoroughly in the e2e test (Task 10). For now, verify the CLI parses correctly:

Run:
```bash
cd tidepool
npx tsx bin/cli.ts connect --help
npx tsx bin/cli.ts requests --help
```

Expected: Help text displays correctly with all options.

- [ ] **Step 4: Commit**

```bash
git add tidepool/bin/cli.ts
git commit -m "feat(tidepool): CLI connect and requests commands"
```

---

### Task 9: Store Pending Requests (deny mode)

**Files:**
- Modify: `tidepool/src/handshake.ts`
- Modify: `tidepool/test/handshake.test.ts`

When mode is `deny`, the server should store the request in `pending-requests.json` so the user can review them with `tidepool requests` and manually approve.

- [ ] **Step 1: Write the failing test**

Add to `tidepool/test/handshake.test.ts`:

```typescript
import fs from "fs";
import path from "path";
import os from "os";
import { storePendingRequest, loadPendingRequests } from "../src/handshake.js";

describe("pending requests storage", () => {
  let tmpDir: string;
  let pendingPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pending-"));
    pendingPath = path.join(tmpDir, "pending-requests.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("stores a pending request to disk", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(1);
    expect(requests[0].fingerprint).toBe("sha256:aaaa");
    expect(requests[0].reason).toBe("Want to learn Rust");
  });

  it("appends to existing requests", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "First request",
      agentCardUrl: "https://example.com/card1.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    storePendingRequest(pendingPath, {
      fingerprint: "sha256:bbbb",
      reason: "Second request",
      agentCardUrl: "https://example.com/card2.json",
      receivedAt: new Date("2026-04-13T01:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(2);
  });

  it("returns empty array for missing file", () => {
    const requests = loadPendingRequests(path.join(tmpDir, "nonexistent.json"));
    expect(requests).toHaveLength(0);
  });

  it("deduplicates by fingerprint", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "First attempt",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "Second attempt",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T01:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe("Second attempt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tidepool && pnpm test -- test/handshake.test.ts`
Expected: FAIL — `storePendingRequest` and `loadPendingRequests` are not exported.

- [ ] **Step 3: Add pending request storage to handshake.ts**

Add to `tidepool/src/handshake.ts`:

```typescript
import fs from "fs";
import type { ConnectionRequest } from "./types.js";

interface StoredRequest {
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  receivedAt: string;
}

export function storePendingRequest(
  filePath: string,
  request: ConnectionRequest,
): void {
  const existing = loadPendingRequests(filePath);

  // Deduplicate by fingerprint — update if exists
  const filtered = existing.filter(
    (r) => r.fingerprint !== request.fingerprint,
  );
  filtered.push({
    fingerprint: request.fingerprint,
    reason: request.reason,
    agentCardUrl: request.agentCardUrl,
    receivedAt: request.receivedAt.toISOString(),
  });

  fs.writeFileSync(
    filePath,
    JSON.stringify({ requests: filtered }, null, 2),
  );
}

export function loadPendingRequests(filePath: string): StoredRequest[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as { requests: StoredRequest[] };
    return parsed.requests ?? [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tidepool && pnpm test -- test/handshake.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Wire pending storage into the deny mode handler**

Update the `deny` case in `handleConnectionRequest` in `tidepool/src/handshake.ts`:

Replace:
```typescript
    case "deny": {
      return {
        response: buildDeniedResponse("Not accepting connections at this time"),
      };
    }
```

With:
```typescript
    case "deny": {
      // Store the request so the user can review with `tidepool requests`
      if (opts.pendingRequestsPath) {
        storePendingRequest(opts.pendingRequestsPath, {
          fingerprint,
          reason,
          agentCardUrl,
          receivedAt: new Date(),
        });
      }
      return {
        response: buildDeniedResponse("Not accepting connections at this time"),
      };
    }
```

Also add `pendingRequestsPath?: string;` to the `HandleConnectionRequestOpts` interface:

```typescript
interface HandleConnectionRequestOpts {
  config: ConnectionRequestConfig;
  friends: FriendsConfig;
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  fetchAgentCard: (url: string) => Promise<{ name: string }>;
  evaluateWithLLM?: (opts: {
    reason: string;
    agentCardUrl: string;
    agentName: string;
    policy: string;
  }) => Promise<{ decision: "accept" | "deny"; reason?: string }>;
  pendingRequestsPath?: string;
}
```

- [ ] **Step 6: Update server.ts to pass pendingRequestsPath**

In `tidepool/src/server.ts`, in the `handleConnectionRequest` call inside `createPublicApp`, add the path:

Find the `handleConnectionRequest({` call and add after `agentCardUrl: metadata.agentCardUrl,`:

```typescript
              pendingRequestsPath: `${configDir}/pending-requests.json`,
```

- [ ] **Step 7: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add tidepool/src/handshake.ts tidepool/test/handshake.test.ts tidepool/src/server.ts
git commit -m "feat(tidepool): store pending connection requests for deny mode review"
```

---

### Task 10: End-to-End Handshake Test

**Files:**
- Create: `tidepool/test/e2e-handshake.test.ts`

This test proves the full flow: an unknown agent sends a CONNECTION_REQUEST, the server processes it based on mode, and the friend list is updated.

- [ ] **Step 1: Write the e2e handshake test**

Create `tidepool/test/e2e-handshake.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { loadFriendsConfig } from "../src/config.js";

describe("e2e: connection handshake", () => {
  let tmpDir: string;

  // Bob's server (accepts connections)
  let bobConfigDir: string;
  let bobServer: { close: () => void };
  let bobMockAgent: http.Server;

  // Alice's identity (the stranger requesting a connection)
  let aliceConfigDir: string;
  let aliceCert: Buffer;
  let aliceKey: Buffer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-handshake-"));

    // --- Alice's identity (no server, just a cert) ---
    aliceConfigDir = path.join(tmpDir, "alice");
    fs.mkdirSync(path.join(aliceConfigDir, "agents/alice-dev"), {
      recursive: true,
    });

    await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "agents/alice-dev/identity.crt"),
      keyPath: path.join(aliceConfigDir, "agents/alice-dev/identity.key"),
    });

    aliceCert = fs.readFileSync(
      path.join(aliceConfigDir, "agents/alice-dev/identity.crt"),
    );
    aliceKey = fs.readFileSync(
      path.join(aliceConfigDir, "agents/alice-dev/identity.key"),
    );

    // --- Alice's mock agent card server (plain HTTP for fetchAgentCard) ---
    const aliceCardApp = express();
    aliceCardApp.get(
      "/alice-dev/.well-known/agent-card.json",
      (_req, res) => {
        res.json({
          name: "alice-dev",
          description: "Alice's dev agent",
          url: "https://alice.example.com:9900/alice-dev",
        });
      },
    );
    const aliceCardServer = aliceCardApp.listen(48800, "127.0.0.1");

    // --- Bob's setup (accept mode) ---
    bobConfigDir = path.join(tmpDir, "bob");
    fs.mkdirSync(path.join(bobConfigDir, "agents/rust-expert"), {
      recursive: true,
    });

    await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "agents/rust-expert/identity.crt"),
      keyPath: path.join(bobConfigDir, "agents/rust-expert/identity.key"),
    });

    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 39900,
          host: "0.0.0.0",
          localPort: 39901,
          rateLimit: "100/hour",
        },
        agents: {
          "rust-expert": {
            localEndpoint: "http://127.0.0.1:48801",
            rateLimit: "50/hour",
            description: "Bob's Rust expert",
          },
        },
        connectionRequests: { mode: "accept" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Start with no friends
    fs.writeFileSync(
      path.join(bobConfigDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    // Bob's mock agent
    const bobApp = express();
    bobApp.use(express.json());
    bobApp.post("/message\\:send", (req, res) => {
      res.json({
        id: "task-bob",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [
          {
            artifactId: "response",
            parts: [{ kind: "text", text: "rust-expert says hello" }],
          },
        ],
      });
    });
    bobMockAgent = bobApp.listen(48801, "127.0.0.1");

    // Start Bob's server
    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [],
    });

    // Give servers a moment to bind
    await new Promise((r) => setTimeout(r, 200));

    // Cleanup alice card server on teardown
    afterAll(() => {
      aliceCardServer.close();
    });
  });

  afterAll(() => {
    bobMockAgent?.close();
    bobServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rejects normal requests from unknown agents", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-1",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "Hello!" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(401);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Not a friend");
  });

  it("accepts a CONNECTION_REQUEST from an unknown agent (accept mode)", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "conn-req-1",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
            extensions: ["https://tidepool.dev/ext/connection/v1"],
            metadata: {
              "https://tidepool.dev/ext/connection/v1": {
                type: "request",
                reason: "Want to learn Rust error handling",
                agent_card_url:
                  "http://127.0.0.1:48800/alice-dev/.well-known/agent-card.json",
              },
            },
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      status: { state: string };
      artifacts: Array<{
        metadata: Record<string, Record<string, string>>;
      }>;
    };
    expect(data.status.state).toBe("TASK_STATE_COMPLETED");
    expect(
      data.artifacts[0].metadata["https://tidepool.dev/ext/connection/v1"]
        .type,
    ).toBe("accepted");
  });

  it("persisted the new friend to friends.toml", () => {
    const friendsConfig = loadFriendsConfig(
      path.join(bobConfigDir, "friends.toml"),
    );

    // Alice should now be a friend
    const friendHandles = Object.keys(friendsConfig.friends);
    expect(friendHandles.length).toBeGreaterThanOrEqual(1);

    // Find alice's entry (handle derived from agent card name)
    const aliceEntry = Object.entries(friendsConfig.friends).find(
      ([handle]) => handle.startsWith("alice"),
    );
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry![1].fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("allows Alice to make normal requests after being friended", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-post-friend",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "How do you handle errors?" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      status: { state: string };
      artifacts: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(data.status.state).toBe("TASK_STATE_COMPLETED");
    expect(data.artifacts[0].parts[0].text).toBe("rust-expert says hello");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd tidepool && pnpm test -- test/e2e-handshake.test.ts`
Expected: 4 tests PASS.

If there are failures, debug them. Common issues:
- Port conflicts — ensure ports 39900, 39901, 48800, 48801 are free
- The `fetchAgentCard` in server.ts needs to reach Alice's mock card server at `http://127.0.0.1:48800`
- Express route matching — the `message:send` colon may need escaping in route patterns

- [ ] **Step 3: Fix any issues and re-run until passing**

Address any failures. Re-run: `cd tidepool && pnpm test -- test/e2e-handshake.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tidepool/test/e2e-handshake.test.ts
git commit -m "test(tidepool): e2e handshake — unknown agent sends CONNECTION_REQUEST, gets friended"
```

---

### Task 11: Add @ai-sdk/anthropic Dependency

**Files:**
- Modify: `tidepool/package.json`

The auto mode evaluator in `handshake.ts` uses `ai` (Vercel AI SDK) and `@ai-sdk/anthropic`. The `ai` package is already in the parent project, but `tidepool` needs its own dependency.

- [ ] **Step 1: Install dependencies**

Run:
```bash
cd tidepool && pnpm add ai @ai-sdk/anthropic
```

- [ ] **Step 2: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors. The dynamic imports in `handshake.ts` (`await import("ai")` and `await import("@ai-sdk/anthropic")`) should now resolve.

- [ ] **Step 3: Commit**

```bash
git add tidepool/package.json tidepool/pnpm-lock.yaml
git commit -m "feat(tidepool): add ai and @ai-sdk/anthropic for auto mode evaluation"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd tidepool && pnpm test`
Expected: All tests PASS across all files (identity, config, middleware, proxy, agent-card, friends, handshake, e2e, e2e-handshake).

- [ ] **Step 2: Run typecheck**

Run: `cd tidepool && pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Manual smoke test — friends CLI**

```bash
cd tidepool

npx tsx bin/cli.ts init --dir /tmp/cc-phase2
npx tsx bin/cli.ts register --name test-agent --description "Test" --endpoint http://localhost:18800 --dir /tmp/cc-phase2

# Add a friend
npx tsx bin/cli.ts friends add --handle remote-peer --fingerprint "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" --dir /tmp/cc-phase2

# List friends
npx tsx bin/cli.ts friends list --dir /tmp/cc-phase2

# Remove friend
npx tsx bin/cli.ts friends remove remote-peer --dir /tmp/cc-phase2

# Verify removed
npx tsx bin/cli.ts friends list --dir /tmp/cc-phase2

# Check connect help
npx tsx bin/cli.ts connect --help

# Check requests
npx tsx bin/cli.ts requests --dir /tmp/cc-phase2
```

Expected:
```
Added friend "remote-peer" — sha256:0123... (all agents)
  remote-peer — sha256:0123... (all agents)
Removed friend "remote-peer"
No friends yet.
Usage: tidepool connect [options] <agent-card-url>
No pending connection requests.
```

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/cc-phase2
```

- [ ] **Step 5: Final commit**

```bash
git add -A tidepool/
git commit -m "feat(tidepool): Phase 2 complete — friends management and connection handshake"
```
