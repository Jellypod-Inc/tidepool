# A2A v1.0 Wire-Layer Migration Design

**Status:** Approved (2026-04-13)
**Supersedes discussion:** "Should we adopt a2a-js?" — answered: not yet; a2a-js targets spec v0.3.

## Context

Claw Connect's thesis is clear: **A2A is the language agents speak. Claw Connect is the network — discovery, identity, trust, routing — that lets independent agents actually find and reach each other without a shared CA.** Today's primary target is a peer-to-peer laptop mesh (developers running ≥1 agents, ad-hoc trust); future target is an internet-scale marketplace.

That positioning means Claw Connect owns a network layer on top of A2A. The wire-shape work (message, task, streaming event, agent card) is A2A's concern, and we'd rather defer to the spec or an SDK than hand-roll it.

**The constraint driving this design:** we must use A2A **v1.0** (the stable spec as of 2026-03-12). The official TS SDK `a2a-js` is still on v0.3.13 with no visible v1.0 work. An unofficial Rust SDK (`agntcy/a2a-rs`) exists and claims v1.0 but ships a non-spec-compliant proto-JSON enum dialect and single-vendor governance — rejected.

**The further problem our audit surfaced:** our current code isn't even v0.3. It emits a pre-ADR-001 verbose enum dialect (`"TASK_STATE_COMPLETED"`, `"ROLE_USER"`, `final: true` on status-update, `stateTransitionHistory` capability) that even a2a-js v0.3 rejects. Migrating to v1.0 takes ~20% more work than aligning with v0.3, and is work we must do regardless.

## Decision

Stay in TypeScript. Hand-roll a **thin, v1.0-spec-compliant A2A wire module** at `src/a2a.ts`. Keep everything that makes Claw Connect *Claw Connect* (friends, discovery, handshake, pinning, tenancy, policy) untouched. When `a2a-js` ships v1.0, swap the contents of `a2a.ts` for SDK re-exports — callers unchanged.

## Architecture

### Layer boundary

One new file, `src/a2a.ts`, is the sole home for A2A protocol v1.0 concerns and acts as an internal mini-SDK.

**`a2a.ts` owns:**
- Types: `Message`, `Task`, `TaskState`, `Role`, `Part`, `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `StreamEvent`, `AgentCard`, `AgentCapabilities`, `Extension`.
- Zod schemas matching those types for wire-boundary validation.
- SSE helpers: `parseSseStream`, `formatSseEvent`, `buildFailedStatusEvent`.
- Extension carriage helpers: `parseExtensionsHeader`, `formatExtensionsHeader`, `declareExtension`.
- A terminality helper: `isTerminalState(state) → boolean`, encapsulating the v1.0 rule that `{completed, failed, canceled, rejected}` ends a task (the `final` field was removed in v1.0).

**`a2a.ts` does NOT own:**
- Any Claw Connect concept: friends, discovery, handshake, tenancy, routing, pinning, rate limits.
- Express routing or server wiring.
- Configuration loading.

**Import discipline:** `a2a.ts` is the only file importing wire-shape things from zod for A2A purposes. All other code (`agent-card.ts`, `streaming.ts`, `errors.ts`, `handshake.ts`, `server.ts`) imports wire types from `./a2a.js`. This makes future SDK adoption a one-file swap.

### Slimming `types.ts` and `schemas.ts`

- `types.ts` keeps only Claw-Connect-specific types (`ServerConfig`, `FriendsConfig`, `FriendEntry`, `RemoteAgent`, `AgentIdentity`, `ConnectionRequestConfig`, `ConnectionRequest`, `PendingRequests`, `DiscoveryConfig`, `StaticPeer`, `AgentConfig`). A2A types are deleted.
- `schemas.ts` keeps only config schemas (`ServerConfigSchema`, `FriendsConfigSchema`). Wire-shape schemas move to `a2a.ts` and are updated to v1.0.

## v1.0 Wire Types (contents of `a2a.ts`)

### `TaskState` — ADR-001 lowercase

```ts
type TaskState =
  | "submitted" | "working" | "input-required"
  | "completed" | "failed" | "canceled" | "rejected" | "auth-required";
```

Replaces today's `"TASK_STATE_*"` strings throughout. Note American "canceled" per v1.0 standardization (#1283).

### `Role`

```ts
type Role = "user" | "agent";
```

Replaces `"ROLE_USER"` / `"ROLE_AGENT"`.

### `Part` — flattened per v1.0 (#1411)

```ts
type FileContent = {
  name?: string;
  mimeType?: string;
  bytes?: string;   // base64
  uri?: string;     // alternative to inline bytes
};

type Part =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: FileContent; metadata?: Record<string, unknown> }
  | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };
```

Today we only emit `text` parts — that shape is forward-compatible. Change is we now validate *inbound* parts against the full union.

### `Message`

```ts
interface Message {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
}
```

### `TaskStatusUpdateEvent` — drops `final` (#1308)

```ts
interface TaskStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: {
    state: TaskState;
    timestamp?: string;
    message?: Message;
  };
  // no `final` — terminality inferred from `state`
}
```

### `TaskArtifactUpdateEvent`

Shape unchanged from today, re-exported from `a2a.ts`.

### `Task` (minimal)

```ts
interface Task {
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string; message?: Message };
  artifacts?: Array<{
    artifactId: string;
    parts: Part[];
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}
```

Included so we can validate upstream responses and fit the `StreamEvent` union. We do **not** implement `tasks/get`, `tasks/list`, or any task-management RPC endpoints — only the type for passthrough validation.

### `StreamEvent`

```ts
type StreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message | Task;
```

Naming aligned with `a2a-js`'s `A2AStreamEventData` so future SDK adoption is drop-in.

### `AgentCard` — v1.0 structural changes

```ts
interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  capabilities: AgentCapabilities;
  securitySchemes: Record<string, SecurityScheme>;
  securityRequirements: Record<string, string[]>[];
}

interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  supportsExtendedAgentCard?: boolean;   // renamed + relocated per #1222, #1307
  extensions?: Extension[];              // v1.0: extensions declared here
}

interface Extension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}
```

Deltas from today: drop `capabilities.stateTransitionHistory` (#1396); add `capabilities.extensions`; rename+relocate `supportsAuthenticatedExtendedCard`; tighten `securityRequirements` scope typing.

### Zod schemas

Every type above has a matching zod schema exported from `a2a.ts` (`MessageSchema`, `TaskStatusUpdateEventSchema`, `AgentCardSchema`, etc.). Schemas are *permissive on unknown extra fields* (peers can add metadata) but *strict on fields we consume*.

### Explicitly out of scope

`tasks/get`, `tasks/list`, push-notification configs, authenticated extended card flow. These are v1.0 RPC surfaces we don't use today; add when a feature needs them. The minimal `Task` type above is in scope only for passthrough validation.

## CONNECTION_REQUEST extension (v1.0 carriage)

Our extension URI (`https://clawconnect.dev/ext/connection/v1`) and semantics are unchanged. The *carriage* updates to v1.0:

### 1. Declare in Agent Card

Today we don't declare the extension — peers can't tell we speak it. In v1.0, the local Agent Card declares:

```ts
capabilities: {
  streaming: true,
  pushNotifications: false,
  extensions: [{
    uri: "https://clawconnect.dev/ext/connection/v1",
    description: "Claw Connect peer friending handshake",
    required: false,
  }],
}
```

### 2. Parse `X-A2A-Extensions` on inbound

Per v1.0, clients MAY announce used extensions via the `X-A2A-Extensions` header *in addition to* `message.extensions`. `middleware.ts::isConnectionRequest` becomes: the request declared the extension via **either** signal AND the first text part is `CONNECTION_REQUEST`.

### 3. Emit `X-A2A-Extensions` on outbound handshake response

When the handshake code path runs, the HTTP response carries `X-A2A-Extensions: https://clawconnect.dev/ext/connection/v1` so peers can confirm we activated their extension.

### 4. Response body

Current handshake response shape (task-like object with `artifacts[0].metadata[URI]`) tightens to a v1.0-conformant `Message` with extension metadata. Semantic content (`type: "accepted"` / `"pending"` / `"denied"`) unchanged.

### Why not adopt a2a-js's `AgentExecutor` wrapper pattern

Our inline-detect-then-delegate flow is the right fit for a proxy architecture. a2a-js's pattern is for agent *execution*, not routing. Wrapping an executor we don't have would be ceremony without benefit.

## File-by-file migration touches

**New:**
- `src/a2a.ts` — types, schemas, SSE helpers, extension helpers, terminality helper.

**Edited:**
| File | Change |
|------|--------|
| `src/types.ts` | Delete A2A types; keep Claw-Connect-only types. |
| `src/schemas.ts` | Delete wire-shape schemas; keep config schemas. |
| `src/streaming.ts` | `buildFailedEvent` moves to `a2a.ts` as `buildFailedStatusEvent`. Drop `final: true`. Lowercase enums. |
| `src/errors.ts` | `"TASK_STATE_FAILED"` → `"failed"`; `"TASK_STATE_REJECTED"` → `"rejected"`. |
| `src/agent-card.ts` | Drop `stateTransitionHistory`; add `capabilities.extensions` declaration; v1.0 security shape; import types from `a2a.ts`. |
| `src/handshake.ts` | Response is a v1.0 `Message`; lowercase enums. |
| `src/middleware.ts` | `isConnectionRequest` accepts `headers` arg; checks both `X-A2A-Extensions` header and `message.extensions`. |
| `src/server.ts` | Route parses `X-A2A-Extensions` from request; sets it on handshake response; update literal strings in 504 catch path. |
| `src/ping.ts` | Import `AgentCardSchema` from `a2a.ts`. No logic change. |
| All test files | Mechanical sweep: uppercase enums → lowercase; remove `final:` assertions; remove `stateTransitionHistory` assertions; update `capabilities` shape. |

**Untouched:**
- `src/outbound-tls.ts`, `src/friends.ts`, `src/identity.ts`, `src/rate-limiter.ts`, `src/proxy.ts`, `src/config.ts`, `src/status.ts`, `src/directory-server.ts`, all `src/discovery/*`, `bin/cli.ts`.

## Data flow and validation

**Inbound (public interface):**

```
Request arrives → express.json parse
  → MessageSchema.safeParse(body.message)
      ✗ → 400 "Malformed A2A message"
      ✓ → middleware pipeline (rate limit → fingerprint → friend → scope)
      → forward to upstream OR handshake branch
```

Today bad input causes `undefined.field` crashes deep in middleware. Post-migration it's caught at the door.

**Outbound upstream:**

```
Upstream response arrives
  → JSON parse
  → validate against the action-appropriate schema:
      message:send   → MessageSchema | TaskSchema
      message:stream → each SSE event against StreamEventSchema
      ✗ → wrap in a v1.0 failed status event, surface to caller
      ✓ → pass through
```

Protects our peers from misbehaving upstream agents.

## Error response shapes

`sendA2AError` continues to build task-like error bodies. Only the enum strings change:
- `"failed"` — infrastructure (rate limit, timeout, agent not found)
- `"rejected"` — access control (not a friend, scope denied)

Status code mapping (429/403/404/504) unchanged. The per-error `id = req.body?.message?.messageId ?? uuidv4()` correlation (added in the Task 6 cleanup on 2026-04-13) stays.

## Testing strategy

Three layers:

1. **New unit tests for `a2a.ts`.** For each schema: one positive (valid v1.0 parses), one negative (verbose legacy dialect is rejected), one round-trip (encode → decode is structurally equivalent). ~25-30 new tests.
2. **Mechanical sweep of existing tests.** Grep-and-replace uppercase enums, `final:` fields, `stateTransitionHistory`. 1-2 line edits per test. Behaviors under test do not change.
3. **Regression proof.** Every integration test (`e2e.test.ts`, `e2e-handshake.test.ts`, `streaming-e2e.test.ts`, `discovery-e2e.test.ts`, `mTLS-pinning.test.ts`, `e2e-rate-limit.test.ts`) runs pre- and post-migration. Green → green across every protocol seam.

## Definition of done

- `pnpm typecheck` clean.
- `pnpm test` green, `155 + N` tests passing (N = new `a2a.ts` unit tests).
- `grep -rn "TASK_STATE_\|ROLE_\|final:\s*true\|stateTransitionHistory" src/ test/` returns 0 matches.
- Agent Card emitted by the server validates against a v1.0 conformance check: we boot a server, GET `/:tenant/.well-known/agent-card.json`, run the response through our `AgentCardSchema`, and assert it conforms — equivalent to schema-based validation until/unless a canonical v1.0 JSON schema file is vendored.

## Non-goals

- No performance work — zod parse cost is negligible next to TLS + fetch.
- No new features — CONNECTION_REQUEST semantics unchanged; only carriage is updated.
- No CLI/bin changes.
- No new A2A surfaces (`tasks/get`, `tasks/list`, push notifications, auth-extended card). Add when needed.
- No refactor of Claw Connect concerns (friends, discovery, handshake, pinning, proxy, rate-limiter, policy). They're the value add and stay as-is.

## Simplicity and DRY

- **Single file for the wire layer.** Don't grow `a2a.ts` into a directory prematurely. When it passes ~500 lines or we add SDK-shaped sub-modules, revisit.
- **One validation per boundary.** Don't double-parse the same payload inside a function and at its caller.
- **Terminality via `isTerminalState(state)`.** Callers never hard-code the set of terminal states.
- **One extensions helper pair.** `parseExtensionsHeader` / `formatExtensionsHeader`. No bespoke parsing sprinkled elsewhere.
- **Don't duplicate types between `types.ts` and `a2a.ts`.** Every A2A wire type lives in exactly one place.

## Future evolution

- When a2a-js ships v1.0, replace `a2a.ts` contents with re-exports from `@a2a-js/sdk`. Callers don't change.
- When scaling toward Option (D) (internet-scale marketplace), the wire seam is already clean — reputation, identity, directory federation can layer on without touching the protocol boundary.
