# Tidepool: Review Follow-ups (Deferred Fixes)

**Context:** After Phase 1–5 implementation, five parallel code-reviewer subagents (one per phase) reviewed the work. Most issues were fixed in commit 5204d4a. This plan tracks what was **not** fixed and why, plus concrete steps to address them later.

**Spec:** `docs/superpowers/specs/2026-04-13-tidepool-revised-design.md`
**Starting state:** All 140 tests passing, typecheck clean. No regressions expected from any item here.

---

## Task 1: Outbound mTLS fingerprint pinning

**Severity:** Critical (real spec violation)
**Deferred because:** Requires refactoring outbound HTTP from `undici.Agent` + `fetch` to Node's `https.request`. Non-trivial because the three places that do outbound mTLS (public agent card fetch, local-app remote proxy for non-streaming, local-app remote proxy for streaming) would all need to change, and the streaming path currently relies on `Response.body.getReader()` semantics that differ from `https.IncomingMessage`.

**Spec reference:** §Identity / "mTLS Verification":
> After friendship: every request, the server extracts the cert fingerprint from the TLS handshake and verifies it matches what's stored in `friends.toml`. Mismatch → `401`.

**Current gap:** Inbound pinning works (`server.ts` uses `extractFingerprint(peerCert?.raw)` on every request). Outbound uses `rejectUnauthorized: false` and never compares the remote peer's cert to `remote.certFingerprint`. A MITM with any self-signed cert would be accepted.

**Why the obvious fix didn't work:** With `rejectUnauthorized: false`, Node's TLS does not call `checkServerIdentity`, so the cleanest hook point is unavailable. Confirmed and a TODO is already in `src/server.ts`.

### Steps

- [ ] **Step 1: Pick an approach**

  Options:
  - **A. Custom `connect` function in `undici.Agent`.** Undici's connect option can be a function that returns a socket; we can call `tls.connect` ourselves, attach a listener, and verify the fingerprint before returning. Preserves the fetch API.
  - **B. Ditch fetch for outbound. Use `https.request`.** Gives direct `res.socket.getPeerCertificate({ raw: true })` after headers arrive. Requires adapting streaming code: `res` (`IncomingMessage`) is a Node stream, not a `ReadableStream`, so `proxySSEStream` needs either to accept `Readable` or to wrap it via `Readable.toWeb`.
  - **C. Hybrid.** Keep fetch for non-streaming (wrap via option A); only rewrite streaming with option B.

  Recommended: **A** for minimal surface change.

- [ ] **Step 2: Write a failing test**

  Create `test/mTLS-pinning.test.ts`:
  - Spin up a server-A with a valid registered-agent cert and friends.toml listing server-B's fingerprint under handle `bob`.
  - Spin up a DIFFERENT server-B' with a freshly generated cert NOT matching the pinned fingerprint.
  - Have server-A's local interface proxy a request to `bob` (which maps to server-B's endpoint but server-B' is what's actually listening).
  - Assert the outbound call fails with a clear "fingerprint mismatch" error, not silently succeeds.

- [ ] **Step 3: Implement option A**

  In `src/server.ts` `createLocalApp`, replace the inline `new Agent({ connect: { cert, key, rejectUnauthorized: false } })` with a helper `buildPinnedDispatcher(certPath, keyPath, expectedFingerprint)` that returns an Agent whose `connect` is a function. Inside the function, call `tls.connect` with the TLS options, wait for `secureConnect`, extract `socket.getPeerCertificate(true).raw`, compute fingerprint, and either resolve with the socket or `socket.destroy(err)` on mismatch.

  Also apply this to `fetchRemoteAgentCard` callers when fetching from peers (currently uses plain `fetch` with no mTLS — confirm the spec's posture here: peer Agent Card fetches should probably also be mTLS-pinned).

- [ ] **Step 4: Verify test passes + existing tests still pass**

  Run `pnpm test`. The new test should pass; all previously-passing tests should continue to pass.

- [ ] **Step 5: Remove the TODO comment in `src/server.ts`**

---

## Task 2: Full discovery → connect e2e test

**Severity:** Important (plan called for it; functionality works but end-to-end integration is untested)
**Deferred because:** The individual providers (static, directory, registry) already have unit + integration tests. The e2e gap is specifically "discovery result feeds into `tidepool connect`", which requires coordinating three servers (discovery target, directory, requester).

### Steps

- [ ] **Step 1: Create `test/discovery-e2e.test.ts`**

  Structure: three actors.
  - **Bob's server:** registered agent `rust-expert`, `connectionRequests.mode = "accept"`, advertises to a local cloud directory at bootup.
  - **Directory server:** in-process via `createDirectoryApp()`.
  - **Alice:** a CLI-style caller that queries the directory via `DirectoryProvider`, picks `rust-expert`, then sends a `CONNECTION_REQUEST` through mTLS to Bob.

- [ ] **Step 2: Assertions**

  - Alice's discovery query returns `rust-expert` with `status: "online"` via the directory.
  - Alice's `CONNECTION_REQUEST` to Bob succeeds.
  - Bob's `friends.toml` now contains Alice's fingerprint.
  - Alice can then send a normal `message:send` to Bob and get a response (proving the full cycle: discovery → handshake → routed A2A).

- [ ] **Step 3: Verify**

  `pnpm test -- test/discovery-e2e.test.ts` passes.

---

## Task 3: Typed validation for external JSON

**Severity:** Minor (Phase 1 & Phase 5 reviewers flagged)
**Deferred because:** No current runtime failures; all parse sites are internally-consistent. Fixing is pure hardening.

**Current gap:** `config.ts` uses unchecked `as` casts. `fetchRemoteAgentCard`, `pingAgent`, and various `await resp.json() as any` sites accept whatever shape arrives. Malformed input produces `undefined` field access at runtime.

### Steps

- [ ] **Step 1: Add `zod` as a dev-or-runtime dep**

  `pnpm add zod`.

- [ ] **Step 2: Define schemas**

  Create `src/schemas.ts` with zod schemas for `ServerConfig`, `FriendsConfig`, `AgentCard`, `PingResponse`. Export both the schema and the inferred type — replace hand-written `interface` definitions where they fully match.

- [ ] **Step 3: Validate at boundaries**

  - `loadServerConfig` / `loadFriendsConfig` → `.parse()` the TOML-parsed object; surface clear errors (line/path of bad field) on malformed configs.
  - `fetchRemoteAgentCard` → `.safeParse()`; return null on failure (same behavior, but typed).
  - `pingAgent` → `.safeParse()`.
  - `DirectoryProvider.search`/`resolve` → `.safeParse()` the `{ agents: [...] }` and per-entry shape.

- [ ] **Step 4: Tests**

  For each validation site, add a test that feeds malformed input and asserts the correct handled-failure behavior (throw on config, null on card/ping).

---

## Task 4: Rich agent card `securitySchemes` drop — add explanatory comment

**Severity:** Trivial
**Deferred because:** Intentional behavior; just needs a comment so future readers don't "fix" it.

### Steps

- [ ] Add a comment above the `securitySchemes: {}, securityRequirements: []` lines in `buildRichRemoteAgentCard` (`src/agent-card.ts`) explaining that the local interface is plain HTTP on localhost and deliberately drops the remote card's mTLS scheme so local agents don't try to present client certs when talking to their own Tidepool.

---

## Task 5: File-lock-grade serialization of friends.toml (optional hardening)

**Severity:** Minor
**Deferred because:** The in-process Promise-chain mutex added in commit 5204d4a is sufficient for the single-process case. A cross-process race would require OS-level locking, which is out of scope for v1 (there's one server process per config dir).

**Only revisit if:** v2 introduces supervisor/worker architecture or hot-reload with parallel writers. Then use `proper-lockfile` or equivalent.

---

## Task 6: Better error response `id` correlation

**Severity:** Minor (Phase 3 reviewer flagged)
**Deferred because:** Cosmetic — A2A clients don't currently rely on echoing task IDs in errors.

**Current behavior:** Error responses generate fresh `uuidv4()` IDs regardless of inbound `message.messageId`.

### Steps

- [ ] **Step 1:** Update `A2AErrorResponse` builders in `src/errors.ts` to optionally accept `taskId`.
- [ ] **Step 2:** In `server.ts`, pass `req.body?.message?.messageId` into error builders so clients can correlate errors to their requests.
- [ ] **Step 3:** Update `test/errors.test.ts` with correlation assertions.

---

## Verification

After completing any task above:

```bash
cd tidepool
pnpm typecheck && pnpm test
```

Both must pass before the change is considered complete. Current baseline: 22 test files, 140 tests passing, 0 skipped.
