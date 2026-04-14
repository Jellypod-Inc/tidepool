# A2A Wire Validation Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire zod-schema validation gates at Claw Connect's two A2A boundaries — inbound request bodies in `src/server.ts` and upstream SSE events in `src/streaming.ts::proxySSEStream` — behind a `validation.mode` config knob that starts in `"warn"` (log + pass through) and can be flipped to `"enforce"` (reject on fail).

**Architecture:** Add a single small helper `validateWire(schema, data, { mode, onWarn, context })` that both seams call. In `"warn"` mode, failures are logged with a structured one-line message to `console.warn` and the raw data passes through unchanged. In `"enforce"` mode, failures return a sentinel that lets the caller reject the request (HTTP 400) or terminate the stream (emit `buildFailedStatusEvent` + end). Config lives on `ServerConfig.validation` and defaults to `"warn"` to keep rollout safe.

**Tech Stack:** TypeScript 5.9, vitest 3.2, zod 4.3, express 5, undici 7. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-13-a2a-v1-migration-design.md` §"Data flow and validation" — this plan implements what the migration plan explicitly deferred in its §"Explicitly deferred" note.

**Starting state:** 181/181 tests passing, typecheck clean, latest commit `54a0278 fix(handshake): validate and time-bound peer agent card fetch`. All work happens in `/Users/piersonmarks/src/tries/2026-04-13-clawconnect/claw-connect/`. All `pnpm` commands run from that directory.

---

## File structure

**New:**
- `src/wire-validation.ts` — `validateWire` helper + structured logger (~80 lines)
- `test/wire-validation.test.ts` — unit tests for the helper

**Edited (source):**
- `src/schemas.ts` — append `validation` block to `ServerConfigSchema`
- `src/types.ts` — add `validation` field to `ServerConfig` interface
- `src/server.ts` — call `validateWire` on `req.body.message` at both `/:tenant/:action` handlers; on enforce-fail, return A2A 400 error
- `src/streaming.ts` — call `validateWire` on each parsed upstream SSE event; on enforce-fail, emit `buildFailedStatusEvent` and end the stream
- `src/errors.ts` — new `malformedRequestResponse(taskId?)` error builder (400 `"failed"`)

**Edited (tests):**
- `test/errors.test.ts` — cover `malformedRequestResponse`
- `test/config.test.ts` — cover `validation` default + parsing
- `test/e2e.test.ts` — one "malformed body rejected in enforce mode" test

**Untouched:** `src/a2a.ts`, `src/handshake.ts`, `src/middleware.ts`, `src/agent-card.ts`, `src/ping.ts`, all discovery code, all friends/identity/rate-limiter/proxy code.

---

## Task 1: Add `wire-validation.ts` helper + unit tests (TDD)

**Files:**
- Create: `src/wire-validation.ts`
- Create: `test/wire-validation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/wire-validation.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { validateWire } from "../src/wire-validation.js";

const SampleSchema = z.object({ foo: z.string() });

describe("validateWire", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { ok: true, data } when input conforms", () => {
    const result = validateWire(SampleSchema, { foo: "bar" }, {
      mode: "warn",
      context: "test",
    });
    expect(result).toEqual({ ok: true, data: { foo: "bar" } });
  });

  it("warn mode: returns { ok: true, data: raw } AND logs on failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = { foo: 123 };
    const result = validateWire(SampleSchema, raw, {
      mode: "warn",
      context: "inbound.message",
    });
    expect(result).toEqual({ ok: true, data: raw });
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("wire-validation");
    expect(message).toContain("inbound.message");
    expect(message).toContain("foo");
  });

  it("enforce mode: returns { ok: false, error } AND logs on failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateWire(SampleSchema, { foo: 123 }, {
      mode: "enforce",
      context: "sse.event",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/foo/);
    }
    expect(warn).toHaveBeenCalledOnce();
  });

  it("log message is single line and carries a stable prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateWire(SampleSchema, { foo: 123 }, {
      mode: "warn",
      context: "inbound.message",
    });
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message.startsWith("[wire-validation]")).toBe(true);
    expect(message).not.toContain("\n");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test -- test/wire-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/wire-validation.ts`**

Create `src/wire-validation.ts`:

```ts
import type { ZodTypeAny, z } from "zod";

export type ValidationMode = "warn" | "enforce";

export type ValidateWireResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

interface ValidateWireOpts {
  mode: ValidationMode;
  context: string;
}

/**
 * Single entry point for schema validation at wire boundaries. In `warn` mode,
 * validation failures are logged but the raw payload flows through unchanged,
 * letting operators observe non-conforming peers without breaking interop. In
 * `enforce` mode, failures short-circuit the caller (HTTP 400 or failed stream
 * event).
 */
export function validateWire<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  opts: ValidateWireOpts,
): ValidateWireResult<z.infer<S>> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  const issueSummary = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const line = `[wire-validation] ${opts.mode} ${opts.context} — ${issueSummary}`;
  console.warn(line);

  if (opts.mode === "warn") {
    return { ok: true, data: data as z.infer<S> };
  }
  return { ok: false, error: issueSummary };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm typecheck && pnpm test -- test/wire-validation.test.ts`
Expected: 4 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/wire-validation.ts test/wire-validation.test.ts
git commit -m "feat(wire-validation): add validateWire helper with warn/enforce modes"
```

---

## Task 2: Add `validation.mode` to `ServerConfig`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/schemas.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Update test first — expect default "warn" and acceptance of "enforce"**

Append to `test/config.test.ts` (inside the existing top-level describe):

```ts
describe("validation config", () => {
  it("defaults to warn mode when omitted", () => {
    const parsed = ServerConfigSchema.parse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
    });
    expect(parsed.validation.mode).toBe("warn");
  });

  it("accepts enforce mode", () => {
    const parsed = ServerConfigSchema.parse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      validation: { mode: "enforce" },
    });
    expect(parsed.validation.mode).toBe("enforce");
  });

  it("rejects invalid mode values", () => {
    const result = ServerConfigSchema.safeParse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      validation: { mode: "panic" },
    });
    expect(result.success).toBe(false);
  });
});
```

Make sure the top of `test/config.test.ts` imports `ServerConfigSchema` if it isn't already.

- [ ] **Step 2: Run tests; expect failure**

Run: `pnpm test -- test/config.test.ts`
Expected: FAIL — `parsed.validation` undefined / rejection.

- [ ] **Step 3: Update `src/types.ts` — add `validation` field**

Find the `ServerConfig` interface and add the field:

```ts
export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
    streamTimeoutSeconds: number;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: ConnectionRequestConfig;
  discovery: DiscoveryConfig;
  validation: ValidationConfig;
}

export interface ValidationConfig {
  mode: "warn" | "enforce";
}
```

- [ ] **Step 4: Update `src/schemas.ts` — append validation schema and wire into `ServerConfigSchema`**

Add above the `ServerConfigSchema` definition:

```ts
const ValidationConfigSchema = z.object({
  mode: z.enum(["warn", "enforce"]).default("warn"),
});
```

Then add the field inside `ServerConfigSchema.object({ ... })`:

```ts
  validation: ValidationConfigSchema.default({ mode: "warn" }),
```

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: all pass, including the 3 new validation-config tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/schemas.ts test/config.test.ts
git commit -m "feat(config): add validation.mode with default warn"
```

---

## Task 3: Add `malformedRequestResponse` error builder

**Files:**
- Modify: `src/errors.ts`
- Modify: `test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/errors.test.ts`:

```ts
describe("malformedRequestResponse", () => {
  it("returns 400 with state=failed and the supplied detail", () => {
    const resp = malformedRequestResponse("messageId: invalid enum value", "m-1");
    expect(resp.status).toBe(400);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.id).toBe("m-1");
    expect(resp.body.artifacts[0].parts[0].text).toContain(
      "messageId: invalid enum value",
    );
  });

  it("generates a uuid when no taskId is provided", () => {
    const resp = malformedRequestResponse("bad role");
    expect(resp.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

Make sure `malformedRequestResponse` is imported at the top of `test/errors.test.ts`.

- [ ] **Step 2: Run tests; expect failure**

Run: `pnpm test -- test/errors.test.ts`
Expected: FAIL — `malformedRequestResponse` is not exported.

- [ ] **Step 3: Implement in `src/errors.ts`**

Append to `src/errors.ts`:

```ts
export function malformedRequestResponse(
  detail: string,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    400,
    "failed",
    `Malformed A2A message: ${detail}`,
    {},
    taskId,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test -- test/errors.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat(errors): add malformedRequestResponse (400 failed)"
```

---

## Task 4: Wire inbound validation at both `/:tenant/:action` handlers

**Files:**
- Modify: `src/server.ts`

Both handlers (public interface at ~line 178, local interface at ~line 443) should validate `req.body.message` before the friendship/scope checks. The call uses the same `validateWire` helper with mode drawn from `config.validation.mode`.

- [ ] **Step 1: Update `src/server.ts` imports**

Ensure these are imported (add what is missing):

```ts
import { MessageSchema } from "./a2a.js";
import { validateWire } from "./wire-validation.js";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
  malformedRequestResponse,
  sendA2AError,
  type A2AErrorResponse,
} from "./errors.js";
```

- [ ] **Step 2: Insert validation at the top of the public handler**

In `src/server.ts`, find:

```ts
  app.post(
    "/:tenant/:action",
    async (req, res) => {
      const { tenant, action } = req.params;
      const messageId: string | undefined = req.body?.message?.messageId;

      // --- Step 1: Server rate limit ---
```

Insert a Step 0 block immediately before `// --- Step 1: Server rate limit ---`:

```ts
      // --- Step 0: Validate inbound A2A message envelope ---
      const inbound = validateWire(
        MessageSchema,
        req.body?.message,
        { mode: config.validation.mode, context: "inbound.public.message" },
      );
      if (!inbound.ok) {
        sendA2AError(res, malformedRequestResponse(inbound.error, messageId));
        return;
      }
```

- [ ] **Step 3: Insert validation at the top of the local handler**

Find the local interface handler (around line 443 — `app.post("/:tenant/:action", async (req, res) => { ... const isStream = action === "message:stream";`) and repeat the same block with a different context label:

```ts
      const inbound = validateWire(
        MessageSchema,
        req.body?.message,
        { mode: config.validation.mode, context: "inbound.local.message" },
      );
      if (!inbound.ok) {
        sendA2AError(res, malformedRequestResponse(inbound.error, req.body?.message?.messageId));
        return;
      }
```

Place it immediately after the handler extracts `tenant`/`action` and before it begins resolving the tenant.

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all 181 existing tests still pass. In `warn` mode (the default), `validateWire` always returns `ok: true`, so existing behavior is unchanged except for a `console.warn` when a test deliberately sends invalid input. If any existing test emits warnings it didn't before, investigate — it may indicate a real bug where our own code emits off-spec shapes.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): validate inbound message envelope in both handlers"
```

---

## Task 5: Wire upstream SSE event validation in `proxySSEStream`

**Files:**
- Modify: `src/streaming.ts`
- Modify: `src/server.ts` (pass mode through to `proxySSEStream`)

Today `proxySSEStream` forwards raw line bytes downstream without parsing individual events. To validate, we need to parse each `data: ...` line against `StreamEventSchema`. In `warn` mode we still forward the raw line; in `enforce` mode we abort the stream with `buildFailedStatusEvent` and end.

- [ ] **Step 1: Add `mode` to `proxySSEStream` options**

In `src/streaming.ts`, update the signature:

```ts
export async function proxySSEStream(opts: {
  upstreamResponse: Response;
  downstream: ExpressResponse;
  timeoutMs: number;
  taskId: string;
  contextId: string;
  validationMode: ValidationMode;
}): Promise<void> {
```

Import at top:

```ts
import { formatSseEvent, parseSseLine, buildFailedStatusEvent, StreamEventSchema } from "./a2a.js";
import { validateWire, type ValidationMode } from "./wire-validation.js";
```

- [ ] **Step 2: Validate each parsed event inside the read loop**

Replace the inner `for (const line of lines) { ... }` body with:

```ts
      for (const line of lines) {
        if (closed) break;
        if (!line.trim()) {
          downstream.write("\n");
          continue;
        }

        const parsed = parseSseLine(line);
        if (parsed !== null) {
          const result = validateWire(StreamEventSchema, parsed, {
            mode: opts.validationMode,
            context: "upstream.sse.event",
          });
          if (!result.ok) {
            sse.write(
              buildFailedStatusEvent(
                taskId,
                contextId,
                `Upstream sent malformed event: ${result.error}`,
              ),
            );
            cleanup();
            return;
          }
        }

        downstream.write(line + "\n");
      }
```

Rationale:
- Non-data lines (`event:`, `:` comments, blanks) pass through untouched.
- Data lines with invalid JSON already return `null` from `parseSseLine` — those also pass through (warn-mode upstream bug surfacing is the validator's job, not the SSE line parser).
- Data lines that parse to JSON but fail schema → warn-log (mode=warn, `validateWire` returns ok:true) and forward OR end stream (mode=enforce).

- [ ] **Step 3: Pass `config.validation.mode` through from `server.ts`**

In `src/server.ts`, find each call to `proxySSEStream({ ... })` (search for `proxySSEStream(`) and add `validationMode: config.validation.mode` to the options object. There should be two call sites, one in each `/:tenant/:action` handler.

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all pass. The existing `streaming-e2e.test.ts` emits valid v1.0 events so it shouldn't trigger any warnings.

- [ ] **Step 5: Commit**

```bash
git add src/streaming.ts src/server.ts
git commit -m "feat(streaming): validate each upstream SSE event against StreamEventSchema"
```

---

## Task 6: End-to-end coverage for enforce mode

**Files:**
- Modify: `test/e2e.test.ts`
- Modify: `test/streaming-e2e.test.ts`

Both tests already boot a full server with a mock peer. We add one enforce-mode test in each file to prove the gates actually reject malformed input.

- [ ] **Step 1: Add "malformed inbound body is rejected with 400 in enforce mode" to `test/e2e.test.ts`**

Find the existing `beforeAll` in `test/e2e.test.ts`. It writes `server.toml` without a `validation` block. We need a separate describe that boots a second server configured for `enforce`. Rather than restructure, append a new `describe` at the bottom of the file that sets up its own fixture:

```ts
describe("inbound validation: enforce mode", () => {
  let tmpDir: string;
  let server: { close: () => void };
  let clientCert: Buffer;
  let clientKey: Buffer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-enforce-"));
    const configDir = path.join(tmpDir, "host");
    fs.mkdirSync(path.join(configDir, "agents/probe"), { recursive: true });

    await generateIdentity({
      name: "probe",
      certPath: path.join(configDir, "agents/probe/identity.crt"),
      keyPath: path.join(configDir, "agents/probe/identity.key"),
    });

    const peerDir = path.join(tmpDir, "peer");
    fs.mkdirSync(path.join(peerDir, "agents/peer"), { recursive: true });
    await generateIdentity({
      name: "peer",
      certPath: path.join(peerDir, "agents/peer/identity.crt"),
      keyPath: path.join(peerDir, "agents/peer/identity.key"),
    });
    clientCert = fs.readFileSync(path.join(peerDir, "agents/peer/identity.crt"));
    clientKey = fs.readFileSync(path.join(peerDir, "agents/peer/identity.key"));

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 58800,
          host: "0.0.0.0",
          localPort: 58801,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          probe: {
            localEndpoint: "http://127.0.0.1:58802",
            rateLimit: "50/hour",
            description: "probe",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "enforce" },
      } as any),
    );
    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    server = await startServer({ configDir, remoteAgents: [] });
  });

  afterAll(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rejects a body with verbose-dialect role with HTTP 400", async () => {
    const res = await fetch("https://127.0.0.1:58800/probe/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m-bad",
          role: "ROLE_USER",
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
      // @ts-expect-error — undici dispatcher for mTLS
      dispatcher: new UndiciAgent({
        connect: { cert: clientCert, key: clientKey, rejectUnauthorized: false },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: { state: string } };
    expect(body.status.state).toBe("failed");
  });
});
```

Add the imports if they aren't already present at the top:

```ts
import { Agent as UndiciAgent } from "undici";
```

- [ ] **Step 2: Add "malformed SSE event ends stream with failed event in enforce mode" to `test/streaming-e2e.test.ts`**

Read the existing `beforeAll` in `test/streaming-e2e.test.ts` to understand the fixture shape (identity generation, config dir, server.toml, friends.toml, mock upstream agent on its own port). Append a new `describe` block at the end of the file that mirrors that fixture but changes three things:

1. Use distinct ports (e.g., 58900 public, 58901 local, 58902 mock agent) to avoid collisions.
2. Add `validation: { mode: "enforce" }` to the `server.toml` written in `beforeAll`.
3. In the mock upstream agent's `/message\\:stream` handler, emit exactly one malformed event frame and then close:

```ts
  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Verbose-dialect state — rejected by TaskStateSchema under enforce mode.
    res.write(
      formatSseEvent({
        kind: "status-update",
        taskId: "t1",
        contextId: "c1",
        status: { state: "TASK_STATE_COMPLETED" },
      }),
    );
    res.end();
  });
```

The test body:

```ts
  it("terminates the stream with a failed status-update when upstream sends a malformed event", async () => {
    const res = await fetch("https://127.0.0.1:58900/probe/message:stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m-1",
          role: "user",
          parts: [{ kind: "text", text: "go" }],
        },
      }),
      // @ts-expect-error — undici dispatcher for mTLS
      dispatcher: new UndiciAgent({
        connect: { cert: clientCert, key: clientKey, rejectUnauthorized: false },
      }),
    });
    expect(res.ok).toBe(true);

    const text = await res.text();
    const events = text
      .split("\n")
      .map((l) => parseSseLine(l))
      .filter((e): e is Record<string, unknown> => e !== null);

    const last = events[events.length - 1] as {
      kind: string;
      status: { state: string; message: { parts: { text: string }[] } };
    };
    expect(last.kind).toBe("status-update");
    expect(last.status.state).toBe("failed");
    expect(last.status.message.parts[0].text).toMatch(/Upstream sent malformed event/);
  });
```

Imports to add (if not already present):

```ts
import { parseSseLine } from "../src/a2a.js";
import { Agent as UndiciAgent } from "undici";
```

- [ ] **Step 3: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass. Two new tests prove enforce-mode rejection at both seams.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts test/streaming-e2e.test.ts
git commit -m "test(validation): e2e coverage for enforce mode at both wire seams"
```

---

## Task 7: Silence warn logs in unit tests that intentionally emit non-conforming payloads

**Files:**
- Modify: at most one or two test files, depending on what appears

When Tasks 4 and 5 land, some existing tests may start printing `[wire-validation] warn ...` lines because they post bodies with malformed-but-tolerated fields (e.g., tests that post raw objects with no `messageId`). The warnings don't fail tests, but they clutter output. Sweep them in one pass.

- [ ] **Step 1: Run full suite and observe warn lines**

Run: `pnpm test 2>&1 | grep "\[wire-validation\]"` and record which test files produce output.

- [ ] **Step 2: For each flagged test file**

Two options (choose whichever is cleaner for the specific test):
1. Fix the test payload to be a valid v1.0 Message (often just adding `messageId: "..."` and `parts: [{ kind: "text", text: "..." }]`). This is preferred because the test becomes more realistic.
2. Wrap the test call in `vi.spyOn(console, "warn").mockImplementation(() => {})` within a `beforeEach`/`afterEach` pair scoped to that describe block.

Avoid a global console.warn silencer. The log is a product feature; we want to see it fire when it wasn't expected.

- [ ] **Step 3: Re-run full suite**

Run: `pnpm test 2>&1 | grep "\[wire-validation\]"`
Expected: no output, OR only output from tests that deliberately exercise warn-mode logging (e.g., the e2e enforce test doesn't log because it's in enforce mode; the unit tests in Task 1 spy on the warn and mute it already).

- [ ] **Step 4: Commit**

```bash
git add <files fixed>
git commit -m "test: silence or fix spurious warn-validation output"
```

---

## Verification (run after every task)

```bash
pnpm typecheck && pnpm test
```

Both must pass. Tasks 2-5 may transiently fail between the test-first step and the implementation step — that's TDD red→green. A task is done only after its final commit step is green.

## Explicitly deferred (future follow-ups, NOT part of this plan)

- **Per-endpoint validation policy.** Today the mode is global. A future plan could scope enforce to specific `action` values (e.g., enforce on `message:stream` but warn on `message:send`).
- **Log aggregation format.** We use plain `console.warn` single-line messages. If a log shipper lands later, swap the one `console.warn` in `wire-validation.ts` for a structured emit; no callers need to change.
- **Metrics.** No counters/histograms of validation outcomes. Wire in when we have a metrics layer.
- **Upstream SSE frame drop policy.** This plan ends the stream on the first malformed event in enforce mode. A follow-up could instead drop individual frames and keep the stream open, counting failures and tripping a circuit breaker after N bad frames.

## Done state

- `pnpm typecheck` clean.
- `pnpm test` green, ~185 tests (181 + 4-ish new unit tests + 2 e2e + a handful of config tests).
- `ServerConfig.validation.mode` is `"warn"` by default; can be set to `"enforce"` in `server.toml`.
- Malformed inbound requests produce `console.warn` in `warn` mode and HTTP 400 in `enforce` mode.
- Malformed upstream SSE events produce `console.warn` in `warn` mode and stream termination with a `buildFailedStatusEvent` in `enforce` mode.
- `src/wire-validation.ts` is the sole validation seam; neither `server.ts` nor `streaming.ts` calls `schema.safeParse` directly.
