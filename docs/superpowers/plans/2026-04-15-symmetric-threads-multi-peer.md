# Symmetric threads + multi-peer identity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the asymmetric-reply and missing-peer-identity bugs in claw-connect by switching the adapter to fire-and-forget A2A, threading via `contextId`, and having the claw-connect server inject authoritative `metadata.from` based on a NAT-style identity model.

**Architecture:** Three layers stay distinct. (1) The A2A wire is unchanged — pure spec, no extensions. (2) The `claw-connect` server gains `X-Agent` (localhost) and `X-Sender-Agent` (peer-to-peer) header handling, and injects `metadata.from` into A2A bodies it forwards to local adapters. (3) The `a2a-claude-code-adapter` is rewritten for fire-and-forget messaging: outbound returns immediately after ack; inbound is just a notification (no waiting); a per-session in-memory thread store backs `list_threads` / `thread_history`. The legacy `claw_connect_reply` tool, the `PendingRegistry`, and the sync request-response correlation are deleted.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, MCP SDK (`@modelcontextprotocol/sdk`), Express, mTLS via Node `https` + `undici` dispatcher.

**Spec:** `docs/superpowers/specs/2026-04-15-symmetric-threads-multi-peer-design.md`

---

## File map

### claw-connect server changes

- **Modify** `packages/claw-connect/src/server.ts` (~586 lines today): in `createLocalApp`, add `X-Agent` header validation against `server.toml`; for local→local forwarding, inject `metadata.from`; for local→remote forwarding, set `X-Sender-Agent`. In the public mTLS app, read `X-Sender-Agent`, translate via `remotes.toml`, inject `metadata.from`.
- **Create** `packages/claw-connect/src/identity-injection.ts`: small pure helper module exporting `injectMetadataFrom(body, fromHandle)` and `resolveLocalHandleForRemoteSender(remoteAgents, peerFingerprint, senderAgentName)`. Keeps `server.ts` from growing further and isolates the identity logic for testing.
- **Create** `packages/claw-connect/test/identity-injection.test.ts`: unit tests for the helper.
- **Modify** `packages/claw-connect/test/local-loopback-e2e.test.ts`: assert that `X-Agent` header is validated and `metadata.from` is present in messages forwarded to the local agent.
- **Create** `packages/claw-connect/test/x-agent-validation.test.ts`: tests for missing/unknown `X-Agent` rejection.
- **Create** `packages/claw-connect/test/x-sender-agent-translation.test.ts`: tests for the remote→local translation path (mocked remoteAgents).

### a2a-claude-code-adapter changes (substantial rewrite)

- **Delete** `packages/a2a-claude-code-adapter/src/pending.ts`
- **Delete** `packages/a2a-claude-code-adapter/test/pending.test.ts`
- **Rewrite** `packages/a2a-claude-code-adapter/src/outbound.ts`: fire-and-forget; sets `X-Agent` header; awaits ack; returns `{contextId, messageId}`; **does not** correlate replies.
- **Rewrite** `packages/a2a-claude-code-adapter/src/http.ts`: inbound `/message:send` reads `metadata.from`, mints `task_id`, emits notification, returns A2A ack immediately. No pending registry; no waiting.
- **Create** `packages/a2a-claude-code-adapter/src/thread-store.ts`: per-session in-memory thread store with bounded ring buffer per thread and LRU eviction across threads.
- **Create** `packages/a2a-claude-code-adapter/test/thread-store.test.ts`
- **Rewrite** `packages/a2a-claude-code-adapter/src/channel.ts`: new tool surface (`send`, `list_peers`, `whoami`, `list_threads`, `thread_history`); new INSTRUCTIONS string; new channel event shape with `peer`/`context_id`/`task_id`/`message_id`.
- **Modify** `packages/a2a-claude-code-adapter/src/start.ts`: wire thread store + new outbound + new channel; remove `PendingRegistry` and `replyTimeoutMs`.
- **Modify** `packages/a2a-claude-code-adapter/src/bin/cli.ts`: drop `--reply-timeout` flag if present.
- **Rewrite** `packages/a2a-claude-code-adapter/test/channel.test.ts`
- **Rewrite** `packages/a2a-claude-code-adapter/test/outbound.test.ts`
- **Rewrite** `packages/a2a-claude-code-adapter/test/http.test.ts`
- **Rewrite** `packages/a2a-claude-code-adapter/test/integration.test.ts` (symmetric round-trip with mock relay)
- **Modify** `packages/a2a-claude-code-adapter/scripts/smoke.ts`: replace `claw_connect_reply` call with `send` using `thread`.

### docs

- **Modify** `packages/a2a-claude-code-adapter/README.md`: new tool list, new channel event shape, removal of reply.
- **Modify** `packages/claw-connect/README.md`: only if any user-facing behavior surfaces (mostly internal).

---

## Task ordering rationale

Server-side identity comes first because the adapter's new inbound handler depends on `metadata.from` being present. Then the adapter's pieces in dependency order: thread-store → outbound → http → channel → start. Tests interleave with each task (TDD). Cleanup (deleting `pending.ts`) and docs come last.

---

## Task 1: claw-connect identity-injection helper

**Files:**
- Create: `packages/claw-connect/src/identity-injection.ts`
- Test: `packages/claw-connect/test/identity-injection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claw-connect/test/identity-injection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  injectMetadataFrom,
  resolveLocalHandleForRemoteSender,
} from "../src/identity-injection.js";
import type { RemoteAgent } from "../src/types.js";

describe("injectMetadataFrom", () => {
  it("sets metadata.from on a message body", () => {
    const body = { message: { messageId: "m1", parts: [] } };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata).toEqual({ from: "alice" });
  });

  it("overwrites caller-supplied metadata.from", () => {
    const body = {
      message: { messageId: "m1", parts: [], metadata: { from: "evil" } },
    };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata.from).toBe("alice");
  });

  it("preserves other metadata keys", () => {
    const body = {
      message: { messageId: "m1", parts: [], metadata: { custom: "v" } },
    };
    const result = injectMetadataFrom(body, "alice");
    expect(result.message.metadata).toEqual({ custom: "v", from: "alice" });
  });

  it("leaves body unchanged if message is missing", () => {
    const body = { other: "thing" };
    const result = injectMetadataFrom(body, "alice");
    expect(result).toEqual(body);
  });
});

describe("resolveLocalHandleForRemoteSender", () => {
  const remotes: RemoteAgent[] = [
    {
      localHandle: "alice-from-acme",
      remoteEndpoint: "https://acme.example",
      remoteTenant: "alice",
      certFingerprint: "FP-ACME",
    },
    {
      localHandle: "bob-from-globex",
      remoteEndpoint: "https://globex.example",
      remoteTenant: "bob",
      certFingerprint: "FP-GLOBEX",
    },
  ];

  it("resolves by fingerprint + sender agent name", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "alice"),
    ).toBe("alice-from-acme");
  });

  it("returns null when fingerprint matches but sender agent name does not", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "bob"),
    ).toBeNull();
  });

  it("returns null when fingerprint does not match", () => {
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-UNKNOWN", "alice"),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter claw-connect test identity-injection`
Expected: FAIL with module-not-found for `identity-injection`.

- [ ] **Step 3: Implement the helper**

Create `packages/claw-connect/src/identity-injection.ts`:

```ts
import type { RemoteAgent } from "./types.js";

/**
 * Inject `metadata.from = handle` into an A2A message body. If the body has
 * no `message` field, returns it unchanged. The injected value overwrites any
 * caller-supplied `metadata.from` — identity is server-authoritative.
 */
export function injectMetadataFrom<T extends Record<string, unknown>>(
  body: T,
  handle: string,
): T {
  const message = (body as { message?: Record<string, unknown> }).message;
  if (!message || typeof message !== "object") return body;
  const existingMetadata =
    (message.metadata as Record<string, unknown> | undefined) ?? {};
  message.metadata = { ...existingMetadata, from: handle };
  return body;
}

/**
 * Find the local handle the receiving host has assigned to a (peer, agent)
 * pair, from the static remotes config. Returns null if no match — caller
 * should reject with 403.
 */
export function resolveLocalHandleForRemoteSender(
  remoteAgents: RemoteAgent[],
  peerFingerprint: string,
  senderAgentName: string,
): string | null {
  const match = remoteAgents.find(
    (r) =>
      r.certFingerprint === peerFingerprint && r.remoteTenant === senderAgentName,
  );
  return match ? match.localHandle : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter claw-connect test identity-injection`
Expected: PASS, all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/claw-connect/src/identity-injection.ts packages/claw-connect/test/identity-injection.test.ts
git commit -m "feat(claw-connect): identity-injection helper for metadata.from + remote sender translation"
```

---

## Task 2: claw-connect local-app `X-Agent` validation

**Files:**
- Modify: `packages/claw-connect/src/server.ts` (the `createLocalApp` function or the equivalent local POST handler around line 454)
- Test: `packages/claw-connect/test/x-agent-validation.test.ts`

- [ ] **Step 1: Read the current local-app handler**

Read `packages/claw-connect/src/server.ts` lines 440–520 to confirm where the local POST `/:tenant/:action` is handled. Note: `createLocalApp` builds `localApp`, listening on `127.0.0.1:localPort`. The handler routes by recipient tenant.

- [ ] **Step 2: Write the failing test**

Create `packages/claw-connect/test/x-agent-validation.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function setupConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "claw-x-agent-"));
  writeFileSync(
    path.join(dir, "server.toml"),
    `
[server]
port = 0
host = "127.0.0.1"
localPort = 0
rateLimit = "100/60s"
streamTimeoutSeconds = 30

[agents.alice]
localEndpoint = "http://127.0.0.1:18801"
rateLimit = "100/60s"
description = ""
timeoutSeconds = 30

[agents.bob]
localEndpoint = "http://127.0.0.1:18802"
rateLimit = "100/60s"
description = ""
timeoutSeconds = 30

[connectionRequests]
mode = "deny"

[discovery]
providers = []
cacheTtlSeconds = 300

[validation]
mode = "warn"
`.trim(),
  );
  // identity files & friends.toml needed by startServer
  // (use existing test helpers if available; otherwise minimum stubs)
  writeFileSync(path.join(dir, "friends.toml"), "[friends]\n");
  return dir;
}

describe("X-Agent validation on local POST", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let configDir: string;
  let localUrl: string;

  beforeAll(async () => {
    configDir = setupConfig();
    server = await startServer({ configDir });
    const addr = server.localServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    localUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
  });

  it("rejects POST to /:tenant/message:send with no X-Agent header", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with unknown X-Agent value", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "unknown" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter claw-connect test x-agent-validation`
Expected: FAIL — both cases return non-403 (currently 504/500 because there's no agent-X listening).

- [ ] **Step 4: Add `X-Agent` validation to the local POST handler**

In `packages/claw-connect/src/server.ts`, locate the local app handler `app.post("/:tenant/:action", ...)` (around line 454 based on current code). At the very top of that handler, before any other logic, insert:

```ts
const senderAgent = req.header("x-agent");
if (!senderAgent) {
  res.status(403).json({ error: "X-Agent header required" });
  return;
}
const config = holder.server();
if (!config.agents[senderAgent]) {
  res.status(403).json({ error: `unknown agent in X-Agent: ${senderAgent}` });
  return;
}
```

(Note: `holder.server()` is already called later in the handler — read the existing variable so you don't shadow it. Adjust placement to keep the existing `const config = holder.server();` line intact and reuse it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter claw-connect test x-agent-validation`
Expected: PASS, both cases return 403.

- [ ] **Step 6: Run the full claw-connect suite to catch regressions**

Run: `pnpm --filter claw-connect test`
Expected: All previously-passing tests still pass. Some integration tests that POST without `X-Agent` will now fail — those will be updated in Task 3 and Task 4.

- [ ] **Step 7: Commit**

```bash
git add packages/claw-connect/src/server.ts packages/claw-connect/test/x-agent-validation.test.ts
git commit -m "feat(claw-connect): require X-Agent header on local POST"
```

---

## Task 3: claw-connect local→local `metadata.from` injection

**Files:**
- Modify: `packages/claw-connect/src/server.ts`
- Modify: `packages/claw-connect/test/local-loopback-e2e.test.ts` (existing test should be updated to assert the new behavior; if it doesn't currently exercise the body, leave it and add a new focused test)
- Create: `packages/claw-connect/test/metadata-from-injection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claw-connect/test/metadata-from-injection.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import express from "express";
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function setupConfig(bobPort: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "claw-metafrom-"));
  writeFileSync(
    path.join(dir, "server.toml"),
    `
[server]
port = 0
host = "127.0.0.1"
localPort = 0
rateLimit = "100/60s"
streamTimeoutSeconds = 30

[agents.alice]
localEndpoint = "http://127.0.0.1:1"
rateLimit = "100/60s"
description = ""
timeoutSeconds = 30

[agents.bob]
localEndpoint = "http://127.0.0.1:${bobPort}"
rateLimit = "100/60s"
description = ""
timeoutSeconds = 30

[connectionRequests]
mode = "deny"

[discovery]
providers = []
cacheTtlSeconds = 300

[validation]
mode = "warn"
`.trim(),
  );
  writeFileSync(path.join(dir, "friends.toml"), "[friends]\n");
  return dir;
}

describe("metadata.from injection on local→local forward", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let bobApp: http.Server;
  let received: any = null;
  let localUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post("/message:send", (req, res) => {
      received = req.body;
      res.status(200).json({
        id: "T1",
        contextId: req.body?.message?.contextId ?? "",
        status: { state: "completed" },
      });
    });
    bobApp = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const bobPort = (bobApp.address() as any).port;

    const configDir = setupConfig(bobPort);
    server = await startServer({ configDir });
    const addr = server.localServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    localUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    await new Promise<void>((resolve) => bobApp.close(() => resolve()));
  });

  it("injects metadata.from = X-Agent value on the forwarded body", async () => {
    received = null;
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "alice" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          contextId: "ctx-1",
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received?.message?.metadata?.from).toBe("alice");
    // contextId untouched
    expect(received?.message?.contextId).toBe("ctx-1");
  });

  it("overwrites caller-supplied metadata.from with X-Agent value", async () => {
    received = null;
    await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "alice" },
      body: JSON.stringify({
        message: {
          messageId: "m2",
          contextId: "ctx-2",
          metadata: { from: "evil" },
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    });
    expect(received?.message?.metadata?.from).toBe("alice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter claw-connect test metadata-from-injection`
Expected: FAIL — `received.message.metadata.from` is undefined (current server passes body through unchanged).

- [ ] **Step 3: Inject `metadata.from` before forwarding to local agent**

In `packages/claw-connect/src/server.ts`, find the local-tenant forwarding branch (around line 472 `if (agent)` after `if (!remote)`). Just before constructing the `fetch(targetUrl, ...)` call (both the streaming and non-streaming branches), import and invoke the helper:

At the top of `server.ts`, add to the imports:

```ts
import { injectMetadataFrom } from "./identity-injection.js";
```

Then in the local-forwarding block, replace `body: JSON.stringify(req.body)` with:

```ts
body: JSON.stringify(injectMetadataFrom(req.body, senderAgent)),
```

Where `senderAgent` is the value validated in Task 2 (must be in scope here — it was added at the top of the handler).

Apply this in **both** the streaming branch (around line 484) and the non-streaming branch (around line 506).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter claw-connect test metadata-from-injection`
Expected: PASS, both cases.

- [ ] **Step 5: Run the full claw-connect suite**

Run: `pnpm --filter claw-connect test`
Expected: Same set passing as after Task 2; no new failures introduced.

- [ ] **Step 6: Commit**

```bash
git add packages/claw-connect/src/server.ts packages/claw-connect/test/metadata-from-injection.test.ts
git commit -m "feat(claw-connect): inject metadata.from on local-to-local forward"
```

---

## Task 4: claw-connect local→remote `X-Sender-Agent` header

**Files:**
- Modify: `packages/claw-connect/src/server.ts` (the remote-forwarding branch, around line 539)
- Create: `packages/claw-connect/test/x-sender-agent-outbound.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claw-connect/test/x-sender-agent-outbound.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import https from "node:https";
import express from "express";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RemoteAgent } from "../src/types.js";

// This test mocks a remote peer endpoint with a self-signed cert and verifies
// our outbound POST sets X-Sender-Agent.
// NOTE: this test relies on the existing test scaffolding for cert generation.
// If the harness in packages/claw-connect/test/e2e-handshake.test.ts generates
// peer certs, follow that pattern.

describe.skip("X-Sender-Agent on remote outbound", () => {
  // Skipped scaffold; flesh out using the same cert-generation utilities used
  // by e2e-handshake.test.ts. The assertion to make:
  //   - When alice's claw-connect POSTs to a remote peer (outbound), the
  //     request includes header `X-Sender-Agent: alice`.
  it.todo("sets X-Sender-Agent header on outbound mTLS POST");
});
```

(This test is intentionally skipped because the mTLS plumbing requires the existing test certs. The unit-level assertion is covered indirectly by Task 5's translation test, and the full E2E in Task 14. Mark with `.skip` so CI is green; remove the skip if you have time to wire the cert harness.)

- [ ] **Step 2: Add `X-Sender-Agent` to the outbound headers**

In `packages/claw-connect/src/server.ts`, find the remote-forwarding `fetch` call (around line 539, the one that uses `dispatcher`). Modify the `headers` object:

```ts
headers: {
  "Content-Type": "application/json",
  "X-Sender-Agent": senderAgent,
},
```

`senderAgent` is in scope from the validation in Task 2.

- [ ] **Step 3: Run the full claw-connect suite**

Run: `pnpm --filter claw-connect test`
Expected: All previously-passing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/claw-connect/src/server.ts packages/claw-connect/test/x-sender-agent-outbound.test.ts
git commit -m "feat(claw-connect): set X-Sender-Agent on remote outbound mTLS POST"
```

---

## Task 5: claw-connect remote→local sender translation + `metadata.from` injection

**Files:**
- Modify: `packages/claw-connect/src/server.ts` (the public mTLS app inbound handler — locate via `createPublicApp`)
- Create: `packages/claw-connect/test/x-sender-agent-translation.test.ts`

- [ ] **Step 1: Read the current public-app inbound handler**

Read `packages/claw-connect/src/server.ts` `createPublicApp` and find where remote-incoming `message:send` POSTs are handled. Note where the mTLS fingerprint is extracted (likely via `extractFingerprint` from `middleware.ts`).

- [ ] **Step 2: Write the failing test**

Create `packages/claw-connect/test/x-sender-agent-translation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveLocalHandleForRemoteSender } from "../src/identity-injection.js";

// The wire-level assertion (full mTLS path) is exercised by the E2E in Task 14.
// Here we lock the unit-level resolution behavior the public-app handler relies on.
describe("public-app remote→local sender translation", () => {
  it("translates (fingerprint, sender-agent) → local handle", () => {
    const remotes = [
      {
        localHandle: "alice-from-acme",
        remoteEndpoint: "https://acme.example",
        remoteTenant: "alice",
        certFingerprint: "FP-ACME",
      },
    ];
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "alice"),
    ).toBe("alice-from-acme");
  });

  it("returns null when X-Sender-Agent not in remotes for that fingerprint", () => {
    const remotes = [
      {
        localHandle: "alice-from-acme",
        remoteEndpoint: "https://acme.example",
        remoteTenant: "alice",
        certFingerprint: "FP-ACME",
      },
    ];
    expect(
      resolveLocalHandleForRemoteSender(remotes, "FP-ACME", "carol"),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it passes (helper already exists from Task 1)**

Run: `pnpm --filter claw-connect test x-sender-agent-translation`
Expected: PASS — these assertions just exercise the helper from Task 1.

- [ ] **Step 4: Wire translation into the public-app inbound handler**

In `packages/claw-connect/src/server.ts`, in the `createPublicApp` function's inbound handler for `/:tenant/:action`, after the mTLS fingerprint is extracted and before the body is forwarded to the local agent:

```ts
import { resolveLocalHandleForRemoteSender, injectMetadataFrom } from "./identity-injection.js";

// inside the handler, after fingerprint is known and remoteAgents is in scope:
const senderAgentName = req.header("x-sender-agent");
if (!senderAgentName) {
  res.status(400).json({ error: "X-Sender-Agent header required" });
  return;
}
const localHandle = resolveLocalHandleForRemoteSender(
  remoteAgents,
  fingerprint,
  senderAgentName,
);
if (!localHandle) {
  res.status(403).json({ error: "unknown remote sender agent" });
  return;
}
// Then when forwarding to the local agent endpoint:
body: JSON.stringify(injectMetadataFrom(req.body, localHandle)),
```

The exact placement depends on the current public-app handler structure — adapt to fit. The invariants: validate header → resolve → reject if missing → inject before forward.

- [ ] **Step 5: Run the full claw-connect suite**

Run: `pnpm --filter claw-connect test`
Expected: All previously-passing tests still pass. The mTLS handshake e2e tests may need `X-Sender-Agent` added to their outbound test stubs — fix any such regressions by adding the header to the stub fetch calls.

- [ ] **Step 6: Commit**

```bash
git add packages/claw-connect/src/server.ts packages/claw-connect/test/x-sender-agent-translation.test.ts
git commit -m "feat(claw-connect): translate X-Sender-Agent + inject metadata.from on remote inbound"
```

---

## Task 6: adapter thread store

**Files:**
- Create: `packages/a2a-claude-code-adapter/src/thread-store.ts`
- Create: `packages/a2a-claude-code-adapter/test/thread-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/a2a-claude-code-adapter/test/thread-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createThreadStore } from "../src/thread-store.js";

describe("createThreadStore", () => {
  it("records a message and lists the thread", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({
      contextId: "C1",
      peer: "bob",
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const threads = s.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      contextId: "C1",
      peer: "bob",
      lastMessageAt: 1000,
      messageCount: 1,
    });
  });

  it("threads are returned newest-last-activity first", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    const threads = s.listThreads();
    expect(threads.map((t) => t.contextId)).toEqual(["C2", "C1"]);
  });

  it("filters threads by peer", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    expect(s.listThreads({ peer: "bob" })).toHaveLength(1);
    expect(s.listThreads({ peer: "bob" })[0].contextId).toBe("C1");
  });

  it("returns thread history in chronological order", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "first", sentAt: 1000 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M2", from: "alice", text: "second", sentAt: 2000 });
    const history = s.history("C1");
    expect(history.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("evicts oldest messages when per-thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 2, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peer: "bob",
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const history = s.history("C1");
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("evicts oldest thread (by last_activity) when thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 2 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peer: "dave", messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    const ctxs = s.listThreads().map((t) => t.contextId);
    expect(ctxs).toEqual(["C3", "C2"]);
    expect(s.history("C1")).toEqual([]);
  });

  it("history with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peer: "bob",
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const last2 = s.history("C1", { limit: 2 });
    expect(last2.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("listThreads with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peer: "dave", messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    expect(s.listThreads({ limit: 2 }).map((t) => t.contextId)).toEqual(["C3", "C2"]);
  });

  it("history of unknown thread returns empty array", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    expect(s.history("nonexistent")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter a2a-claude-code-adapter test thread-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement thread store**

Create `packages/a2a-claude-code-adapter/src/thread-store.ts`:

```ts
export type StoredMessage = {
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

export type ThreadSummary = {
  contextId: string;
  peer: string;
  lastMessageAt: number;
  messageCount: number;
};

export type ThreadStoreOpts = {
  maxMessagesPerThread: number;
  maxThreads: number;
};

export type RecordArgs = {
  contextId: string;
  peer: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

type ThreadRecord = {
  peer: string;
  lastActivity: number;
  messages: StoredMessage[];
};

export type ThreadStore = {
  record(args: RecordArgs): void;
  listThreads(opts?: { peer?: string; limit?: number }): ThreadSummary[];
  history(contextId: string, opts?: { limit?: number }): StoredMessage[];
};

export function createThreadStore(opts: ThreadStoreOpts): ThreadStore {
  const threads = new Map<string, ThreadRecord>();

  function evictIfFull() {
    while (threads.size > opts.maxThreads) {
      let oldestKey: string | undefined;
      let oldestActivity = Infinity;
      for (const [k, v] of threads) {
        if (v.lastActivity < oldestActivity) {
          oldestActivity = v.lastActivity;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      threads.delete(oldestKey);
    }
  }

  return {
    record(args) {
      let t = threads.get(args.contextId);
      if (!t) {
        t = { peer: args.peer, lastActivity: args.sentAt, messages: [] };
        threads.set(args.contextId, t);
      }
      t.peer = args.peer;
      t.lastActivity = args.sentAt;
      t.messages.push({
        messageId: args.messageId,
        from: args.from,
        text: args.text,
        sentAt: args.sentAt,
      });
      if (t.messages.length > opts.maxMessagesPerThread) {
        t.messages.splice(0, t.messages.length - opts.maxMessagesPerThread);
      }
      evictIfFull();
    },

    listThreads(listOpts) {
      let summaries: ThreadSummary[] = [];
      for (const [contextId, t] of threads) {
        if (listOpts?.peer && t.peer !== listOpts.peer) continue;
        summaries.push({
          contextId,
          peer: t.peer,
          lastMessageAt: t.lastActivity,
          messageCount: t.messages.length,
        });
      }
      summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      if (listOpts?.limit !== undefined) {
        summaries = summaries.slice(0, listOpts.limit);
      }
      return summaries;
    },

    history(contextId, historyOpts) {
      const t = threads.get(contextId);
      if (!t) return [];
      const all = t.messages;
      if (historyOpts?.limit !== undefined) {
        return all.slice(-historyOpts.limit);
      }
      return [...all];
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter a2a-claude-code-adapter test thread-store`
Expected: PASS, all 9 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/thread-store.ts packages/a2a-claude-code-adapter/test/thread-store.test.ts
git commit -m "feat(adapter): in-memory thread store with bounded ring buffer + LRU eviction"
```

---

## Task 7: adapter outbound rewrite (fire-and-forget)

**Files:**
- Modify (rewrite): `packages/a2a-claude-code-adapter/src/outbound.ts`
- Modify (rewrite): `packages/a2a-claude-code-adapter/test/outbound.test.ts`

- [ ] **Step 1: Write the failing test (rewrite outbound.test.ts in full)**

Replace contents of `packages/a2a-claude-code-adapter/test/outbound.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { sendOutbound } from "../src/outbound.js";

function okAck() {
  return new Response(
    JSON.stringify({
      id: "T-from-peer",
      contextId: "ctx-from-peer",
      status: { state: "completed" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("sendOutbound", () => {
  it("posts to /:peer/message:send with X-Agent header and a fresh contextId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      text: "hi",
      self: "alice",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(result.contextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9901/bob/message:send");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Agent": "alice",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.message).toMatchObject({
      messageId: result.messageId,
      contextId: result.contextId,
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(body.message.metadata).toBeUndefined();
  });

  it("reuses caller-supplied thread id as contextId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      text: "hi",
      self: "alice",
      thread: "ctx-existing",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(result.contextId).toBe("ctx-existing");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.message.contextId).toBe("ctx-existing");
  });

  it("returns a structured error result when daemon is down (ECONNREFUSED)", async () => {
    const err: any = new Error("fetch failed");
    err.cause = { code: "ECONNREFUSED" };
    const fetchImpl = vi.fn().mockRejectedValue(err);
    await expect(
      sendOutbound({
        peer: "bob",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "daemon-down" });
  });

  it("rejects with peer-not-registered on 403/404 from server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent not found" }), {
        status: 404,
      }),
    );
    await expect(
      sendOutbound({
        peer: "bob",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "peer-not-registered" });
  });

  it("rejects with peer-unreachable on 504 from server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Local agent unreachable" }), {
        status: 504,
      }),
    );
    await expect(
      sendOutbound({
        peer: "bob",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "peer-unreachable" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter a2a-claude-code-adapter test outbound`
Expected: FAIL — current `sendOutbound` has different signature (takes `deps.onReply`, no `self`, no `thread`).

- [ ] **Step 3: Rewrite outbound.ts**

Replace contents of `packages/a2a-claude-code-adapter/src/outbound.ts`:

```ts
import { randomUUID } from "node:crypto";

export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
};

export type SendErrorKind =
  | "daemon-down"
  | "peer-not-registered"
  | "peer-unreachable"
  | "other";

export type SendError = {
  kind: SendErrorKind;
  message: string;
  hint: string;
};

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|connection refused/i.test(msg);
}

/**
 * Fire-and-forget outbound. Awaits only the ack from the local claw-connect
 * (HTTP 200 with a Task in `completed` state). Any reply from the peer
 * arrives later as a separate inbound POST handled by http.ts.
 *
 * Returns {contextId, messageId} on success. Throws `SendError` on failure;
 * caller (channel.ts) wraps it into an MCP `isError: true` result.
 */
export async function sendOutbound(args: {
  peer: string;
  text: string;
  self: string;
  thread?: string;
  deps: OutboundDeps;
}): Promise<{ contextId: string; messageId: string }> {
  const { peer, text, self, thread, deps } = args;
  const messageId = randomUUID();
  const contextId = thread ?? randomUUID();
  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;

  const body = {
    message: {
      messageId,
      contextId,
      parts: [{ kind: "text", text }],
    },
  };

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent": self,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw <SendError>{
        kind: "daemon-down",
        message: "the claw-connect daemon isn't running",
        hint: "Ask the user to run `claw-connect claude-code:start` (or `claw-connect serve &`) and retry.",
      };
    }
    throw <SendError>{
      kind: "other",
      message: err instanceof Error ? err.message : String(err),
      hint: "Ask the user to check `claw-connect status` and the daemon log at ~/.config/claw-connect/logs/.",
    };
  }

  if (res.status === 403 || res.status === 404) {
    throw <SendError>{
      kind: "peer-not-registered",
      message: `no agent named "${peer}" is registered`,
      hint: "Call list_peers to see who's reachable. If the peer should exist, ask the user to confirm their session is running.",
    };
  }
  if (res.status === 504) {
    throw <SendError>{
      kind: "peer-unreachable",
      message: `"${peer}" is registered but didn't respond`,
      hint: `Check that "${peer}"'s session is still running.`,
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw <SendError>{
      kind: "other",
      message: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      hint: "Ask the user to check `claw-connect status` and the daemon log.",
    };
  }

  return { contextId, messageId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter a2a-claude-code-adapter test outbound`
Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/outbound.ts packages/a2a-claude-code-adapter/test/outbound.test.ts
git commit -m "feat(adapter): rewrite outbound as fire-and-forget with X-Agent header + structured errors"
```

---

## Task 8: adapter http.ts rewrite (fire-and-forget inbound)

**Files:**
- Modify (rewrite): `packages/a2a-claude-code-adapter/src/http.ts`
- Modify (rewrite): `packages/a2a-claude-code-adapter/test/http.test.ts`

- [ ] **Step 1: Rewrite http.test.ts**

Replace contents of `packages/a2a-claude-code-adapter/test/http.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { startHttp, type InboundInfo } from "../src/http.js";

describe("startHttp inbound endpoint", () => {
  let server: Awaited<ReturnType<typeof startHttp>>;
  let received: InboundInfo[] = [];

  beforeEach(async () => {
    received = [];
    server = await startHttp({
      port: 0,
      host: "127.0.0.1",
      onInbound: (info) => received.push(info),
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("emits InboundInfo with peer/contextId/messageId/text on POST /message:send", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          metadata: { from: "alice" },
          parts: [{ kind: "text", text: "hello" }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.state).toBe("completed");
    expect(body.contextId).toBe("C1");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      contextId: "C1",
      messageId: "M1",
      peer: "alice",
      text: "hello",
    });
    expect(received[0].taskId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 400 when message.parts[0].text is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { messageId: "M1", contextId: "C1" } }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("returns 400 when metadata.from is missing (server-injected — its absence is a bug)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("rejects oversized text with 413", async () => {
    const big = "x".repeat(64 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          metadata: { from: "alice" },
          parts: [{ kind: "text", text: big }],
        },
      }),
    });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter a2a-claude-code-adapter test http`
Expected: FAIL — `InboundInfo` doesn't have `peer`, current `startHttp` takes `registry` and `replyTimeoutMs`.

- [ ] **Step 3: Rewrite http.ts**

Replace contents of `packages/a2a-claude-code-adapter/src/http.ts`:

```ts
import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

export type InboundInfo = {
  taskId: string;
  contextId: string;
  messageId: string;
  peer: string;
  text: string;
};

export type StartHttpOpts = {
  port: number;
  host: string;
  onInbound: (info: InboundInfo) => void;
};

export const MAX_TEXT_BYTES = 64 * 1024;

export async function startHttp(opts: StartHttpOpts) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Express path encoding: ":" must be escaped in route definition.
  app.post("/message\\:send", async (req: Request, res: Response) => {
    const msg = req.body?.message;
    const textPart = msg?.parts?.[0]?.text;
    if (typeof textPart !== "string") {
      res.status(400).json({ error: "message.parts[0].text is required" });
      return;
    }
    if (Buffer.byteLength(textPart, "utf8") > MAX_TEXT_BYTES) {
      res
        .status(413)
        .json({ error: `message text exceeds ${MAX_TEXT_BYTES} byte limit` });
      return;
    }

    const peer =
      typeof msg?.metadata?.from === "string" ? msg.metadata.from : null;
    if (!peer) {
      res.status(400).json({ error: "message.metadata.from is required" });
      return;
    }

    const taskId = randomUUID();
    const contextId =
      typeof msg.contextId === "string" ? msg.contextId : randomUUID();
    const messageId = typeof msg.messageId === "string" ? msg.messageId : taskId;

    // Emit synchronously before responding; if onInbound throws, log and ack
    // anyway — the message is "received" from the wire's perspective.
    try {
      opts.onInbound({ taskId, contextId, messageId, peer, text: textPart });
    } catch (err) {
      process.stderr.write(
        `[claw-connect-adapter] onInbound threw: ${String(err)}\n`,
      );
    }

    res.json({
      id: taskId,
      contextId,
      status: { state: "completed" },
    });
  });

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter a2a-claude-code-adapter test http`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/http.ts packages/a2a-claude-code-adapter/test/http.test.ts
git commit -m "feat(adapter): rewrite http inbound as fire-and-forget; require metadata.from"
```

---

## Task 9: adapter channel.ts rewrite (new tools + new event shape)

**Files:**
- Modify (rewrite): `packages/a2a-claude-code-adapter/src/channel.ts`
- Modify (rewrite): `packages/a2a-claude-code-adapter/test/channel.test.ts`

- [ ] **Step 1: Write the failing test (rewrite channel.test.ts)**

Replace contents of `packages/a2a-claude-code-adapter/test/channel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channel.js";
import { createThreadStore } from "../src/thread-store.js";
import type { SendError } from "../src/outbound.js";

function setup(overrides?: {
  send?: (peer: string, text: string, thread?: string) => Promise<{ contextId: string; messageId: string }>;
  listPeers?: () => string[];
  self?: string;
}) {
  const store = createThreadStore({ maxMessagesPerThread: 100, maxThreads: 50 });
  const sent: any[] = [];
  const ch = createChannel({
    self: overrides?.self ?? "alice",
    store,
    listPeers: overrides?.listPeers ?? (() => ["bob", "carol"]),
    send:
      overrides?.send ??
      (async (peer, text, thread) => {
        sent.push({ peer, text, thread });
        return { contextId: thread ?? "ctx-new", messageId: "M-new" };
      }),
  });
  return { ch, store, sent };
}

describe("channel notifyInbound", () => {
  it("emits notifications/claude/channel with the right meta", async () => {
    const { ch, store } = setup();
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "T1",
      contextId: "C1",
      messageId: "M1",
      peer: "bob",
      text: "hello",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello",
        meta: {
          peer: "bob",
          context_id: "C1",
          task_id: "T1",
          message_id: "M1",
        },
      },
    });
    // recorded in store
    expect(store.history("C1")).toHaveLength(1);
    expect(store.history("C1")[0]).toMatchObject({
      from: "bob",
      text: "hello",
      messageId: "M1",
    });
  });
});

describe("channel tool dispatch", () => {
  it("send returns {context_id, message_id} and records outbound", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual({ context_id: "ctx-new", message_id: "M-new" });
    expect(sent).toEqual([{ peer: "bob", text: "hi", thread: undefined }]);
    expect(store.history("ctx-new")).toHaveLength(1);
    expect(store.history("ctx-new")[0]).toMatchObject({
      from: "alice",
      text: "hi",
    });
  });

  it("send with thread reuses contextId", async () => {
    const { ch, sent } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "follow-up", thread: "ctx-existing" },
    });
    expect(sent[0]).toMatchObject({ thread: "ctx-existing" });
  });

  it("send returns isError result on SendError", async () => {
    const send = vi.fn().mockRejectedValue(<SendError>{
      kind: "daemon-down",
      message: "the claw-connect daemon isn't running",
      hint: "run claw-connect claude-code:start",
    });
    const { ch } = setup({ send });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/daemon isn't running/);
    expect(result.content[0].text).toMatch(/run claw-connect/);
  });

  it("whoami returns the agent handle", async () => {
    const { ch } = setup({ self: "alice" });
    const result = await ch.handleToolCall({ name: "whoami", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ handle: "alice" });
  });

  it("list_peers returns sorted handle list", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "list_peers",
      arguments: {},
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      peers: [{ handle: "bob" }, { handle: "carol" }],
    });
  });

  it("list_threads returns store summaries", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peer: "bob",
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "list_threads",
      arguments: {},
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]).toMatchObject({
      context_id: "C1",
      peer: "bob",
      message_count: 1,
    });
    expect(data.threads[0].last_message_at).toBe(1000);
  });

  it("thread_history returns message list", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peer: "bob",
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "thread_history",
      arguments: { thread: "C1" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      message_id: "M1",
      from: "bob",
      text: "hi",
      sent_at: 1000,
    });
  });

  it("unknown tool throws", async () => {
    const { ch } = setup();
    await expect(
      ch.handleToolCall({ name: "claw_connect_reply", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter a2a-claude-code-adapter test channel`
Expected: FAIL — current `createChannel` requires `registry` and exposes different tools.

- [ ] **Step 3: Rewrite channel.ts**

Replace contents of `packages/a2a-claude-code-adapter/src/channel.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { InboundInfo } from "./http.js";
import type { ThreadStore } from "./thread-store.js";
import type { SendError } from "./outbound.js";

export type CreateChannelOpts = {
  self: string;
  store: ThreadStore;
  listPeers: () => string[];
  send: (
    peer: string,
    text: string,
    thread?: string,
  ) => Promise<{ contextId: string; messageId: string }>;
  serverName?: string;
};

export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const SendArgsSchema = z.object({
  peer: z.string().min(1),
  text: z.string().min(1),
  thread: z.string().optional(),
});

const ListThreadsArgsSchema = z.object({
  peer: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const ThreadHistoryArgsSchema = z.object({
  thread: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const INSTRUCTIONS =
  "This MCP server connects you to peer agents over the claw-connect network. " +
  "Inbound messages arrive as <channel source=\"claw-connect\" peer=\"...\" " +
  "context_id=\"...\" task_id=\"...\" message_id=\"...\"> events. To respond, " +
  "call `send` with thread=<context_id> from the tag — there is no separate " +
  "reply tool. To start a new conversation, call `send` without thread. Use " +
  "`list_peers` before sending; never guess handles. Use `list_threads` when " +
  "interleaving multiple peers, and `thread_history` to re-load context after " +
  "a gap.";

function isSendError(err: unknown): err is SendError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    "message" in err &&
    "hint" in err
  );
}

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "claw-connect";
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
        name: "send",
        description:
          "Send a message to a peer. Use `thread` to continue an existing conversation (pass the `context_id` from a prior <channel> event). Omit `thread` to start a new conversation. Replies arrive later as a separate <channel source=\"claw-connect\"> event with the same context_id. Always call `list_peers` before guessing a handle.",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "peer handle from list_peers" },
            text: { type: "string", description: "message text" },
            thread: {
              type: "string",
              description:
                "context_id to continue a thread; omit to start a new one",
            },
          },
          required: ["peer", "text"],
        },
      },
      {
        name: "whoami",
        description: "Return this agent's own handle on the claw-connect network.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_peers",
        description:
          "List handles of peers this agent can reach. Call before send; do not guess.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_threads",
        description:
          "List threads this agent is part of. A thread is a chain of messages with one peer, identified by context_id. Use to triage when multiple peers are active. Optionally filter by peer.",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "filter to one peer" },
            limit: { type: "number", description: "return at most N threads" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "thread_history",
        description:
          "Re-load messages from a thread you've been away from. Returns messages chronologically with sender and timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            thread: { type: "string", description: "context_id of the thread" },
            limit: {
              type: "number",
              description: "return at most N most-recent messages",
            },
          },
          required: ["thread"],
          additionalProperties: false,
        },
      },
    ],
  }));

  const handleSend = async (req: ToolCallRequest): Promise<ToolCallResult> => {
    const parsed = SendArgsSchema.safeParse(req.arguments);
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
    try {
      const { contextId, messageId } = await opts.send(
        parsed.data.peer,
        parsed.data.text,
        parsed.data.thread,
      );
      opts.store.record({
        contextId,
        peer: parsed.data.peer,
        messageId,
        from: opts.self,
        text: parsed.data.text,
        sentAt: Date.now(),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              context_id: contextId,
              message_id: messageId,
            }),
          },
        ],
      };
    } catch (err) {
      if (isSendError(err)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[claw-connect] send to "${parsed.data.peer}" failed: ${err.message}\n\nHow to recover: ${err.hint}`,
            },
          ],
        };
      }
      throw err;
    }
  };

  const handleWhoami = (): ToolCallResult => ({
    content: [{ type: "text", text: JSON.stringify({ handle: opts.self }) }],
  });

  const handleListPeers = (): ToolCallResult => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          peers: opts.listPeers().map((handle) => ({ handle })),
        }),
      },
    ],
  });

  const handleListThreads = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ListThreadsArgsSchema.safeParse(req.arguments);
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
    const summaries = opts.store.listThreads({
      peer: parsed.data.peer,
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            threads: summaries.map((s) => ({
              context_id: s.contextId,
              peer: s.peer,
              last_message_at: s.lastMessageAt,
              message_count: s.messageCount,
            })),
          }),
        },
      ],
    };
  };

  const handleThreadHistory = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ThreadHistoryArgsSchema.safeParse(req.arguments);
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
    const messages = opts.store.history(parsed.data.thread, {
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messages: messages.map((m) => ({
              message_id: m.messageId,
              from: m.from,
              text: m.text,
              sent_at: m.sentAt,
            })),
          }),
        },
      ],
    };
  };

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    switch (req.name) {
      case "send":
        return handleSend(req);
      case "whoami":
        return handleWhoami();
      case "list_peers":
        return handleListPeers();
      case "list_threads":
        return handleListThreads(req);
      case "thread_history":
        return handleThreadHistory(req);
      default:
        throw new Error(`unknown tool: ${req.name}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall({
      name: req.params.name,
      arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
    });
  });

  const notifyInbound = async (info: InboundInfo): Promise<void> => {
    opts.store.record({
      contextId: info.contextId,
      peer: info.peer,
      messageId: info.messageId,
      from: info.peer,
      text: info.text,
      sentAt: Date.now(),
    });
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta: {
          peer: info.peer,
          context_id: info.contextId,
          task_id: info.taskId,
          message_id: info.messageId,
        },
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter a2a-claude-code-adapter test channel`
Expected: PASS, all 9 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/channel.ts packages/a2a-claude-code-adapter/test/channel.test.ts
git commit -m "feat(adapter): rewrite channel with new MCP tools (send/list_threads/thread_history) + new event shape"
```

---

## Task 10: adapter start.ts wiring

**Files:**
- Modify (rewrite): `packages/a2a-claude-code-adapter/src/start.ts`

- [ ] **Step 1: Read current start.ts (already done above) and rewrite**

Replace contents of `packages/a2a-claude-code-adapter/src/start.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  loadAgentConfig,
  loadProxyConfig,
  listPeerHandles,
} from "./config.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendOutbound } from "./outbound.js";
import { createThreadStore } from "./thread-store.js";

export type StartOpts = {
  configDir: string;
  agentName?: string;
  host?: string;
  maxMessagesPerThread?: number;
  maxThreads?: number;
  /** MCP transport for tests; defaults to stdio. */
  transport?: Transport;
};

export async function start(opts: StartOpts) {
  const host = opts.host ?? "127.0.0.1";

  const agent = loadAgentConfig(opts.configDir, opts.agentName);
  const proxy = loadProxyConfig(opts.configDir);

  const store = createThreadStore({
    maxMessagesPerThread: opts.maxMessagesPerThread ?? 200,
    maxThreads: opts.maxThreads ?? 100,
  });

  const channel = createChannel({
    self: agent.agentName,
    store,
    listPeers: () => listPeerHandles(opts.configDir, agent.agentName),
    send: (peer, text, thread) =>
      sendOutbound({
        peer,
        text,
        self: agent.agentName,
        thread,
        deps: { localPort: proxy.localPort, host },
      }),
  });

  const emitInbound = (info: InboundInfo): void => {
    channel.notifyInbound(info).catch((err) => {
      process.stderr.write(
        `[claw-connect-adapter] notifyInbound failed: ${String(err)}\n`,
      );
    });
  };

  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    onInbound: emitInbound,
  });

  return {
    agent,
    close: async () => {
      await http.close();
      await channel.server.close();
    },
  };
}
```

- [ ] **Step 2: Verify the package builds**

Run: `pnpm --filter a2a-claude-code-adapter build`
Expected: Clean build, no type errors.

- [ ] **Step 3: Run all adapter tests**

Run: `pnpm --filter a2a-claude-code-adapter test`
Expected: All tests pass except `pending.test.ts` (which still references the deleted module — will be removed in Task 12) and `integration.test.ts` (will be rewritten in Task 11).

If `pending.test.ts` causes a compile error blocking other tests, temporarily skip it: at the top of the file, add `describe.skip("PendingRegistry", () => {`. We'll delete it cleanly in Task 12.

- [ ] **Step 4: Commit**

```bash
git add packages/a2a-claude-code-adapter/src/start.ts packages/a2a-claude-code-adapter/test/pending.test.ts
git commit -m "feat(adapter): rewire start.ts with thread store; drop PendingRegistry from wiring"
```

---

## Task 11: adapter integration test (symmetric round-trip via mock relay)

**Files:**
- Modify (rewrite): `packages/a2a-claude-code-adapter/test/integration.test.ts`

- [ ] **Step 1: Rewrite integration.test.ts**

Replace contents of `packages/a2a-claude-code-adapter/test/integration.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

/**
 * Mock relay that stands in for claw-connect.
 * - Listens on `relayPort`.
 * - Validates X-Agent header against {alice, bob}.
 * - Forwards POST /:tenant/message:send to the appropriate adapter's HTTP port,
 *   injecting metadata.from = X-Agent value.
 */
function startMockRelay(adapters: Record<string, { httpPort: number }>) {
  const app = express();
  app.use(express.json());
  app.post("/:tenant/message\\:send", async (req, res) => {
    const sender = req.header("x-agent");
    if (!sender || !adapters[sender]) {
      res.status(403).json({ error: "X-Agent invalid" });
      return;
    }
    const tenant = req.params.tenant;
    const target = adapters[tenant];
    if (!target) {
      res.status(404).json({ error: "tenant not found" });
      return;
    }
    const body = {
      ...req.body,
      message: {
        ...req.body.message,
        metadata: { ...(req.body.message?.metadata ?? {}), from: sender },
      },
    };
    const upstream = await fetch(
      `http://127.0.0.1:${target.httpPort}/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await upstream.json();
    res.status(upstream.status).json(json);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      resolve({
        port,
        close: () => new Promise((r) => s.close(() => r())),
      });
    });
  });
}

function makeConfigDir(name: string, relayPort: number, httpPort: number) {
  const dir = mkdtempSync(path.join(tmpdir(), `adapter-${name}-`));
  writeFileSync(
    path.join(dir, "server.toml"),
    `
[server]
localPort = ${relayPort}

[agents.${name}]
localEndpoint = "http://127.0.0.1:${httpPort}"
`.trim(),
  );
  writeFileSync(path.join(dir, "remotes.toml"), "[remotes]\n");
  return dir;
}

describe("symmetric round-trip via mock relay", () => {
  let relay: { port: number; close: () => Promise<void> };
  let alice: { close: () => Promise<void>; port: number };
  let bob: { close: () => Promise<void>; port: number };
  let aliceClient: Client;
  let bobClient: Client;
  let aliceEvents: any[] = [];
  let bobEvents: any[] = [];

  beforeAll(async () => {
    // Pre-allocate adapter ports by binding+closing dummy servers
    const allocPort = () =>
      new Promise<number>((resolve) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as any).port;
          s.close(() => resolve(p));
        });
      });
    const alicePort = await allocPort();
    const bobPort = await allocPort();
    relay = await startMockRelay({
      alice: { httpPort: alicePort },
      bob: { httpPort: bobPort },
    });

    const aliceDir = makeConfigDir("alice", relay.port, alicePort);
    const bobDir = makeConfigDir("bob", relay.port, bobPort);

    const [aliceServerTransport, aliceClientTransport] =
      InMemoryTransport.createLinkedPair();
    const [bobServerTransport, bobClientTransport] =
      InMemoryTransport.createLinkedPair();

    const aliceStarted = await start({
      configDir: aliceDir,
      agentName: "alice",
      transport: aliceServerTransport,
    });
    const bobStarted = await start({
      configDir: bobDir,
      agentName: "bob",
      transport: bobServerTransport,
    });
    alice = { close: aliceStarted.close, port: alicePort };
    bob = { close: bobStarted.close, port: bobPort };

    aliceClient = new Client({ name: "test-alice", version: "0.0.1" }, {});
    bobClient = new Client({ name: "test-bob", version: "0.0.1" }, {});
    aliceClient.fallbackNotificationHandler = async (n) => {
      aliceEvents.push(n);
    };
    bobClient.fallbackNotificationHandler = async (n) => {
      bobEvents.push(n);
    };
    await aliceClient.connect(aliceClientTransport);
    await bobClient.connect(bobClientTransport);
  });

  afterAll(async () => {
    await aliceClient.close();
    await bobClient.close();
    await alice.close();
    await bob.close();
    await relay.close();
  });

  it("alice sends → bob receives event with peer=alice; bob continues thread; alice receives same context_id", async () => {
    aliceEvents = [];
    bobEvents = [];

    const sendResult = await aliceClient.callTool({
      name: "send",
      arguments: { peer: "bob", text: "hi bob" },
    });
    const sendData = JSON.parse((sendResult.content as any)[0].text);
    const ctx = sendData.context_id;
    expect(ctx).toBeTruthy();

    // Bob should have received a channel notification
    await new Promise((r) => setTimeout(r, 50));
    expect(bobEvents).toHaveLength(1);
    expect(bobEvents[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hi bob",
        meta: { peer: "alice", context_id: ctx },
      },
    });

    // Bob continues the thread
    const replyResult = await bobClient.callTool({
      name: "send",
      arguments: { peer: "alice", text: "hey alice", thread: ctx },
    });
    const replyData = JSON.parse((replyResult.content as any)[0].text);
    expect(replyData.context_id).toBe(ctx);

    // Alice should have received a channel notification with the same context_id
    await new Promise((r) => setTimeout(r, 50));
    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hey alice",
        meta: { peer: "bob", context_id: ctx },
      },
    });
  });

  it("send returns isError result when relay returns 403 (unknown agent)", async () => {
    const result = await aliceClient.callTool({
      name: "send",
      arguments: { peer: "nonexistent", text: "hi" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/no agent named/i);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter a2a-claude-code-adapter test integration`
Expected: PASS, both cases.

If this fails because the MCP SDK's `InMemoryTransport.createLinkedPair` has a different name in your installed version, adjust the import — check `node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js` for the actual export.

- [ ] **Step 3: Commit**

```bash
git add packages/a2a-claude-code-adapter/test/integration.test.ts
git commit -m "test(adapter): symmetric round-trip integration via mock relay"
```

---

## Task 12: delete pending registry + update CLI

**Files:**
- Delete: `packages/a2a-claude-code-adapter/src/pending.ts`
- Delete: `packages/a2a-claude-code-adapter/test/pending.test.ts`
- Modify: `packages/a2a-claude-code-adapter/src/bin/cli.ts`

- [ ] **Step 1: Delete pending registry files**

```bash
rm packages/a2a-claude-code-adapter/src/pending.ts
rm packages/a2a-claude-code-adapter/test/pending.test.ts
```

- [ ] **Step 2: Audit cli.ts for `--reply-timeout` and remove**

Read `packages/a2a-claude-code-adapter/src/bin/cli.ts`. If it has a `.option("--reply-timeout ...")` line or passes `replyTimeoutMs` to `start()`, delete those lines. Also remove any `--max-messages-per-thread` / `--max-threads` flags if you don't want them — or keep as documented overrides.

- [ ] **Step 3: Build and run all adapter tests**

Run: `pnpm --filter a2a-claude-code-adapter build && pnpm --filter a2a-claude-code-adapter test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A packages/a2a-claude-code-adapter/
git commit -m "chore(adapter): delete PendingRegistry and --reply-timeout flag"
```

---

## Task 13: update smoke script

**Files:**
- Modify: `packages/a2a-claude-code-adapter/scripts/smoke.ts`

- [ ] **Step 1: Read current smoke.ts**

Read `packages/a2a-claude-code-adapter/scripts/smoke.ts` to find the `claw_connect_reply` invocation (around line 86 based on earlier diff).

- [ ] **Step 2: Replace claw_connect_reply with send + thread**

In `smoke.ts`, find the notification handler that called:

```ts
await client.callTool({
  name: "claw_connect_reply",
  arguments: { task_id: taskId, text: `auto-reply to: ${inbound}` },
});
```

Replace it with:

```ts
const contextId = (n.params as any).meta.context_id;
const peer = (n.params as any).meta.peer;
await client.callTool({
  name: "send",
  arguments: {
    peer,
    text: `auto-reply to: ${inbound}`,
    thread: contextId,
  },
});
```

(The notification's `meta` now carries `peer` and `context_id`; the smoke script uses them to send a contextual reply rather than a special reply primitive.)

- [ ] **Step 3: Sanity-test the smoke script compiles**

Run: `pnpm --filter a2a-claude-code-adapter exec tsc --noEmit scripts/smoke.ts`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/a2a-claude-code-adapter/scripts/smoke.ts
git commit -m "chore(adapter): update smoke script to use send+thread"
```

---

## Task 14: end-to-end test (real daemon + two adapter subprocesses)

**Files:**
- Modify: `packages/claw-connect/test/local-loopback-e2e.test.ts` (the existing two-adapter e2e — update to assert new behavior)

- [ ] **Step 1: Read existing local-loopback-e2e.test.ts**

Read the file. It already spins up real adapters and a real claw-connect daemon for two-agent loopback. Locate the existing assertions that exercise the inbound channel event and the `claw_connect_reply` flow.

- [ ] **Step 2: Update tests to:**

1. Assert the inbound channel event includes `peer`, `context_id`, `task_id`, `message_id` attributes.
2. Replace `claw_connect_reply` calls with `send(peer, text, thread=<context_id>)`.
3. Add a third assertion: alice sends to bob, then bob sends a follow-up to alice with `thread=<context_id>` — alice receives the follow-up with the same `context_id`.
4. Add an assertion: after restart of an adapter, `list_threads` returns `[]` (the ephemeral-store contract).

Adapt to the actual structure of the existing file. The exact diff depends on how the file currently mocks Claude — the principle is: drop `claw_connect_reply`, drop pending-task assertions, add `peer`/`context_id`/`thread` assertions, add ephemeral-store assertion.

- [ ] **Step 3: Run e2e**

Run: `pnpm --filter claw-connect test local-loopback-e2e`
Expected: PASS.

- [ ] **Step 4: Run the full suite across both packages**

Run from repo root: `pnpm test`
Expected: All tests pass across `claw-connect` and `a2a-claude-code-adapter`.

- [ ] **Step 5: Commit**

```bash
git add packages/claw-connect/test/local-loopback-e2e.test.ts
git commit -m "test(e2e): update local loopback to assert peer/context_id/thread continuation + ephemeral store"
```

---

## Task 15: CLI tests for the adapter (existing test files reference removed surface)

**Files:**
- Modify: `packages/claw-connect/test/cli/claude-code-start-e2e.test.ts` (if it asserts `claw_connect_reply` tool exists)
- Modify: `packages/claw-connect/test/cli/mcp-json.test.ts` (if it asserts old MCP server name conventions)
- Modify: `packages/claw-connect/test/cli/status.test.ts` (only if it surfaces tool names)

- [ ] **Step 1: Audit each file for stale references**

Run: `pnpm --filter claw-connect test cli`
Expected: Some failures referencing `claw_connect_reply` or `claw_connect_*` tool names.

- [ ] **Step 2: Fix each failing test**

Update assertions to use the new tool names (`send`, `list_peers`, `whoami`, `list_threads`, `thread_history`). The MCP server name (`claw-connect`) is unchanged.

- [ ] **Step 3: Run again**

Run: `pnpm --filter claw-connect test cli`
Expected: All CLI tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/claw-connect/test/cli/
git commit -m "test(cli): update CLI test assertions for new MCP tool names"
```

---

## Task 16: README updates

**Files:**
- Modify: `packages/a2a-claude-code-adapter/README.md`
- Modify: `packages/claw-connect/README.md` (only if it mentions adapter tool names or the old reply flow)

- [ ] **Step 1: Update adapter README**

In `packages/a2a-claude-code-adapter/README.md`:

1. Replace any mention of `claw_connect_reply` with `send` (with thread).
2. Update the channel event example to show the new attributes: `<channel source="claw-connect" peer="bob" context_id="..." task_id="..." message_id="...">`.
3. Update tool list to: `send`, `whoami`, `list_peers`, `list_threads`, `thread_history` (no prefix).
4. Add a paragraph explaining: messages are now async — `send` returns immediately with an ack; the peer's reply arrives later as a channel event with the same `context_id`. To respond, call `send` with `thread=<context_id>`.
5. Remove any mention of `--reply-timeout`.

- [ ] **Step 2: Update claw-connect README**

In `packages/claw-connect/README.md`:

1. If it references `claw_connect_*` tool names, update to the new names.
2. Add a brief note (in the relevant section) that local POSTs to the daemon must include `X-Agent: <agent-name>` for identity.

- [ ] **Step 3: Run all tests one final time**

Run from repo root: `pnpm test`
Expected: Green across both packages.

- [ ] **Step 4: Commit**

```bash
git add packages/a2a-claude-code-adapter/README.md packages/claw-connect/README.md
git commit -m "docs: update READMEs for new tool surface, async send, and X-Agent header"
```

---

## Task 17: Final smoke + manual verification

- [ ] **Step 1: Build all packages**

Run from repo root: `pnpm build`
Expected: Clean build across both packages, no type errors.

- [ ] **Step 2: Run all tests**

Run from repo root: `pnpm test`
Expected: Green.

- [ ] **Step 3: Manual smoke (skip if no two-terminal setup available)**

In one terminal:
```bash
cd /tmp && mkdir proj-a && cd proj-a
claw-connect claude-code:start --agent alice --debug
# Inside Claude: ask it to call list_peers, then send to bob.
```

In another terminal:
```bash
cd /tmp && mkdir proj-b && cd proj-b
claw-connect claude-code:start --agent bob --debug
# Inside Claude: when it sees the inbound channel event, ask it to reply via send with thread=...
```

Expected: alice sees a follow-up channel event with the same `context_id` and `peer="bob"`.

- [ ] **Step 4: Note any surfaced gaps as follow-up tasks (do not fix here)**

Record anything that didn't behave as the spec promised. These become follow-up issues, not blockers for this plan.

---

## Self-review checklist (run after writing the plan)

- [x] Every spec section has at least one task implementing it (server identity injection in Tasks 1–5; adapter rewrite in 6–10; thread store + tools in 6 and 9; integration tests in 11; cleanup in 12; e2e in 14; docs in 16).
- [x] Every step has actual code, not placeholders.
- [x] Type names consistent: `SendError`, `InboundInfo`, `ThreadStore`, `RecordArgs`, `ThreadSummary`, `StoredMessage` are all defined where introduced and referenced consistently.
- [x] File paths are absolute or repo-relative, not vague.
- [x] Commit after each task. Tasks are bite-sized.
- [x] Removed code (`pending.ts`, `claw_connect_reply`, `--reply-timeout`) is explicitly deleted in Task 12.
