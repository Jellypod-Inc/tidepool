# A2A v1.0 Wire-Layer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Tidepool's A2A wire layer from a pre-ADR-001 verbose dialect (`"TASK_STATE_COMPLETED"`, `"ROLE_USER"`, `final: true`, `stateTransitionHistory`) to A2A spec v1.0 conformance, isolated behind a new `src/a2a.ts` module.

**Architecture:** Introduce `src/a2a.ts` as the sole home for A2A v1.0 types, zod schemas, SSE helpers, extension-header helpers, and a terminality helper. Migrate callers to import wire types from this one file. Keep everything that makes Tidepool *Tidepool* (friends, discovery, handshake, pinning, tenancy, policy) untouched. When `@a2a-js/sdk` ships v1.0, `a2a.ts` contents become a re-export of the SDK.

**Tech Stack:** TypeScript 5.9, vitest 3.2, zod 4.3, express 5, undici 7. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-13-a2a-v1-migration-design.md`

**Starting state:** 155/155 tests passing, typecheck clean. All work happens in `/Users/piersonmarks/src/tries/2026-04-13-tidepool/tidepool/`. All `pnpm` commands run from that directory.

---

## File structure

**New:**
- `src/a2a.ts` — v1.0 wire types, zod schemas, SSE helpers, extension helpers (~400 lines)
- `test/a2a.test.ts` — unit tests for `a2a.ts`

**Edited (source):**
- `src/errors.ts` — lowercase enums
- `src/streaming.ts` — drop duplicate helpers, use a2a.ts, drop `final: true`
- `src/handshake.ts` — v1.0 `Message` response
- `src/agent-card.ts` — drop `stateTransitionHistory`, add `capabilities.extensions`, v1.0 security shape, import from a2a.ts
- `src/middleware.ts` — `isConnectionRequest` accepts headers
- `src/server.ts` — parse/emit `X-A2A-Extensions`, update enum literals in 504 fallback
- `src/ping.ts` — import `AgentCardSchema` from a2a.ts
- `src/types.ts` — delete A2A types (keep Tidepool-only)
- `src/schemas.ts` — delete wire-shape schemas (keep config schemas)

**Edited (tests — mostly mechanical):**
- `test/errors.test.ts`, `test/streaming.test.ts`, `test/handshake.test.ts`, `test/agent-card.test.ts`, `test/agent-card-rich.test.ts`, `test/middleware.test.ts`, `test/cli-ping.test.ts`, `test/e2e.test.ts`, `test/e2e-handshake.test.ts`, `test/e2e-rate-limit.test.ts`, `test/discovery-e2e.test.ts`, `test/streaming-e2e.test.ts`, `test/mTLS-pinning.test.ts`

**Untouched:**
- `src/outbound-tls.ts`, `src/friends.ts`, `src/identity.ts`, `src/rate-limiter.ts`, `src/proxy.ts`, `src/config.ts`, `src/status.ts`, `src/directory-server.ts`, all `src/discovery/*`, `bin/cli.ts`
- `test/config.test.ts`, `test/proxy.test.ts`, `test/friends.test.ts`, `test/identity.test.ts`, `test/rate-limiter.test.ts`, `test/cli-status.test.ts`, `test/discovery/*`, `test/directory-server.test.ts`

---

## Task 1: Create `src/a2a.ts` foundation (types only) + a placeholder test file

**Files:**
- Create: `src/a2a.ts`
- Create: `test/a2a.test.ts`

- [ ] **Step 1: Create the new file `src/a2a.ts` with v1.0 wire types (no schemas/helpers yet)**

Create `src/a2a.ts`:

```ts
/**
 * A2A Protocol v1.0 wire layer.
 *
 * This module is the sole home for A2A protocol types, zod schemas, and
 * protocol-level helpers (SSE parsing, extension header carriage,
 * terminality). All other source files import wire types from here.
 *
 * When @a2a-js/sdk ships v1.0, this file can be replaced with re-exports
 * from the SDK without callers changing their imports.
 *
 * Spec: A2A v1.0 (2026-03-12), ADR-001 ProtoJSON enum format.
 */

// ----- Enums (ADR-001 lowercase) -----

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "auth-required";

export type Role = "user" | "agent";

// ----- File content for file parts -----

export interface FileContent {
  name?: string;
  mimeType?: string;
  bytes?: string; // base64
  uri?: string;
}

// ----- Part (v1.0 flattened, #1411) -----

export type Part =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: FileContent; metadata?: Record<string, unknown> }
  | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };

// ----- Message -----

export interface Message {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

// ----- Task (minimal — no RPC surface, passthrough only) -----

export interface Artifact {
  artifactId: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId: string;
  status: {
    state: TaskState;
    timestamp?: string;
    message?: Message;
  };
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

// ----- Stream events (v1.0: no `final` field, #1308) -----

export interface TaskStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: {
    state: TaskState;
    timestamp?: string;
    message?: Message;
  };
}

export interface TaskArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: Artifact;
}

export type StreamEvent =
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent
  | Message
  | Task;

// ----- Agent Card -----

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface Extension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  supportsExtendedAgentCard?: boolean;
  extensions?: Extension[];
}

// v1.0 SecurityScheme is a tagged union; we only emit mtls today but the
// type permits passthrough of peer-declared schemes.
export type SecurityScheme =
  | { type: "mtls"; description?: string }
  | { type: "apiKey"; in: "query" | "header" | "cookie"; name: string; description?: string }
  | { type: "http"; scheme: string; bearerFormat?: string; description?: string }
  | { type: "oauth2"; flows: Record<string, unknown>; description?: string }
  | { type: "openIdConnect"; openIdConnectUrl: string; description?: string };

export interface AgentCard {
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
```

- [ ] **Step 2: Create a placeholder test file so vitest picks it up**

Create `test/a2a.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { TaskState, Role, Part, Message } from "../src/a2a.js";

describe("a2a types compile", () => {
  it("TaskState accepts v1.0 values", () => {
    const states: TaskState[] = [
      "submitted", "working", "input-required",
      "completed", "failed", "canceled", "rejected", "auth-required",
    ];
    expect(states.length).toBe(8);
  });

  it("Role accepts v1.0 values", () => {
    const roles: Role[] = ["user", "agent"];
    expect(roles.length).toBe(2);
  });

  it("Part discriminates on kind", () => {
    const text: Part = { kind: "text", text: "hi" };
    const file: Part = { kind: "file", file: { mimeType: "image/png", bytes: "..." } };
    const data: Part = { kind: "data", data: { foo: 1 } };
    expect(text.kind).toBe("text");
    expect(file.kind).toBe("file");
    expect(data.kind).toBe("data");
  });

  it("Message requires v1.0 fields", () => {
    const m: Message = {
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
    };
    expect(m.messageId).toBe("m1");
  });
});
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test -- test/a2a.test.ts`
Expected: typecheck clean; 4 tests pass in `a2a.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/a2a.ts test/a2a.test.ts
git commit -m "feat: add a2a.ts with v1.0 wire types"
```

---

## Task 2: Add zod schemas to `a2a.ts`

**Files:**
- Modify: `src/a2a.ts` (append)
- Modify: `test/a2a.test.ts` (append)

- [ ] **Step 1: Write failing tests for the new schemas**

Append to `test/a2a.test.ts`:

```ts
import {
  MessageSchema,
  TaskSchema,
  TaskStatusUpdateEventSchema,
  TaskArtifactUpdateEventSchema,
  StreamEventSchema,
  AgentCardSchema,
  PartSchema,
} from "../src/a2a.js";

describe("MessageSchema", () => {
  it("accepts a valid v1.0 Message", () => {
    const parsed = MessageSchema.safeParse({
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects verbose-enum legacy role", () => {
    const parsed = MessageSchema.safeParse({
      messageId: "m1",
      role: "ROLE_USER",
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts extra unknown fields (loose)", () => {
    const parsed = MessageSchema.safeParse({
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
      futureUnknownField: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("PartSchema", () => {
  it("accepts all three kinds", () => {
    expect(PartSchema.safeParse({ kind: "text", text: "t" }).success).toBe(true);
    expect(PartSchema.safeParse({ kind: "file", file: { mimeType: "x" } }).success).toBe(true);
    expect(PartSchema.safeParse({ kind: "data", data: { a: 1 } }).success).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(PartSchema.safeParse({ kind: "weird", text: "t" }).success).toBe(false);
  });
});

describe("TaskStatusUpdateEventSchema", () => {
  it("accepts a v1.0 event without `final`", () => {
    const parsed = TaskStatusUpdateEventSchema.safeParse({
      kind: "status-update",
      taskId: "t1",
      contextId: "c1",
      status: { state: "completed" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects verbose TASK_STATE_* enum", () => {
    const parsed = TaskStatusUpdateEventSchema.safeParse({
      kind: "status-update",
      taskId: "t1",
      contextId: "c1",
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts `final` as extra field (loose, for forward-compat from v0.3 senders)", () => {
    const parsed = TaskStatusUpdateEventSchema.safeParse({
      kind: "status-update",
      taskId: "t1",
      contextId: "c1",
      status: { state: "completed" },
      final: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("TaskArtifactUpdateEventSchema", () => {
  it("accepts a valid event", () => {
    const parsed = TaskArtifactUpdateEventSchema.safeParse({
      kind: "artifact-update",
      taskId: "t1",
      contextId: "c1",
      artifact: {
        artifactId: "a1",
        parts: [{ kind: "text", text: "done" }],
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("TaskSchema", () => {
  it("accepts a valid minimal Task", () => {
    const parsed = TaskSchema.safeParse({
      id: "t1",
      contextId: "c1",
      status: { state: "completed" },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("StreamEventSchema", () => {
  it("accepts each member of the union", () => {
    expect(
      StreamEventSchema.safeParse({
        kind: "status-update",
        taskId: "t1",
        contextId: "c1",
        status: { state: "working" },
      }).success,
    ).toBe(true);

    expect(
      StreamEventSchema.safeParse({
        messageId: "m1",
        role: "agent",
        parts: [{ kind: "text", text: "hi" }],
      }).success,
    ).toBe(true);
  });
});

describe("AgentCardSchema", () => {
  it("accepts a valid v1.0 card with extensions declaration", () => {
    const parsed = AgentCardSchema.safeParse({
      name: "agent",
      description: "d",
      url: "https://x/agent",
      version: "1.0.0",
      skills: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      capabilities: {
        streaming: true,
        extensions: [{ uri: "https://tidepool.dev/ext/connection/v1" }],
      },
      securitySchemes: { mtls: { type: "mtls", description: "mTLS" } },
      securityRequirements: [{ mtls: [] }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects stateTransitionHistory under capabilities (v1.0 removed it)", () => {
    // stateTransitionHistory is no longer part of the v1.0 schema. We accept
    // extra fields via .loose() on capabilities to tolerate forward-compat,
    // but we do NOT emit it ourselves. Verify permissive parse still works.
    const parsed = AgentCardSchema.safeParse({
      name: "agent",
      description: "d",
      url: "https://x/agent",
      version: "1.0.0",
      skills: [],
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: { streaming: true, stateTransitionHistory: true },
      securitySchemes: {},
      securityRequirements: [],
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm test -- test/a2a.test.ts`
Expected: FAIL — "MessageSchema is not exported" and similar for each schema.

- [ ] **Step 3: Append schemas to `src/a2a.ts`**

Append (at the bottom of the file, after the type definitions):

```ts
// ============================================================
// Zod schemas — for validating external input at wire boundaries
// ============================================================

import { z } from "zod";

export const TaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
  "auth-required",
]);

export const RoleSchema = z.enum(["user", "agent"]);

export const FileContentSchema = z
  .object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().optional(),
    uri: z.string().optional(),
  })
  .loose();

const MetadataSchema = z.record(z.string(), z.unknown()).optional();

export const PartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), metadata: MetadataSchema }),
  z.object({ kind: z.literal("file"), file: FileContentSchema, metadata: MetadataSchema }),
  z.object({
    kind: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
    metadata: MetadataSchema,
  }),
]);

export const MessageSchema = z
  .object({
    messageId: z.string().min(1),
    role: RoleSchema,
    parts: z.array(PartSchema),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    extensions: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1),
  parts: z.array(PartSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    status: z.object({
      state: TaskStateSchema,
      timestamp: z.string().optional(),
      message: MessageSchema.optional(),
    }),
    artifacts: z.array(ArtifactSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const TaskStatusUpdateEventSchema = z
  .object({
    kind: z.literal("status-update"),
    taskId: z.string().min(1),
    contextId: z.string().min(1),
    status: z.object({
      state: TaskStateSchema,
      timestamp: z.string().optional(),
      message: MessageSchema.optional(),
    }),
  })
  .loose();

export const TaskArtifactUpdateEventSchema = z
  .object({
    kind: z.literal("artifact-update"),
    taskId: z.string().min(1),
    contextId: z.string().min(1),
    artifact: ArtifactSchema,
  })
  .loose();

export const StreamEventSchema = z.union([
  TaskStatusUpdateEventSchema,
  TaskArtifactUpdateEventSchema,
  MessageSchema,
  TaskSchema,
]);

export const ExtensionSchema = z.object({
  uri: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const AgentCapabilitiesSchema = z
  .object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    supportsExtendedAgentCard: z.boolean().optional(),
    extensions: z.array(ExtensionSchema).optional(),
  })
  .loose();

const SecuritySchemeSchema = z
  .object({ type: z.string().min(1) })
  .loose();

export const AgentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
});

export const AgentCardSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(""),
    url: z.string().min(1),
    version: z.string().default("1.0.0"),
    skills: z.array(AgentSkillSchema).default([]),
    defaultInputModes: z.array(z.string()).default([]),
    defaultOutputModes: z.array(z.string()).default([]),
    capabilities: AgentCapabilitiesSchema.default({}),
    securitySchemes: z.record(z.string(), SecuritySchemeSchema).default({}),
    securityRequirements: z.array(z.record(z.string(), z.array(z.string()))).default([]),
  })
  .loose();
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm typecheck && pnpm test -- test/a2a.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/a2a.ts test/a2a.test.ts
git commit -m "feat(a2a): add v1.0 zod schemas"
```

---

## Task 3: Add SSE + terminality helpers to `a2a.ts`

**Files:**
- Modify: `src/a2a.ts` (append)
- Modify: `test/a2a.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `test/a2a.test.ts`:

```ts
import {
  formatSseEvent,
  parseSseLine,
  buildFailedStatusEvent,
  isTerminalState,
} from "../src/a2a.js";

describe("formatSseEvent", () => {
  it("formats a JSON object as an SSE data line", () => {
    const event = { kind: "status-update", taskId: "t1" };
    expect(formatSseEvent(event)).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});

describe("parseSseLine", () => {
  it("parses a data: prefixed line", () => {
    const obj = { foo: 1 };
    expect(parseSseLine(`data: ${JSON.stringify(obj)}`)).toEqual(obj);
  });

  it("returns null for comments and blanks", () => {
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine(": keepalive")).toBeNull();
    expect(parseSseLine("event: update")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSseLine("data: {not json")).toBeNull();
  });
});

describe("buildFailedStatusEvent", () => {
  it("builds a v1.0 status-update with state=failed and no `final` field", () => {
    const event = buildFailedStatusEvent("task-1", "ctx-1", "Stream timed out");
    expect(event.kind).toBe("status-update");
    expect(event.taskId).toBe("task-1");
    expect(event.contextId).toBe("ctx-1");
    expect(event.status.state).toBe("failed");
    expect(event.status.message?.parts[0]).toEqual({ kind: "text", text: "Stream timed out" });
    // v1.0 removed `final` — terminality is inferred
    expect((event as any).final).toBeUndefined();
  });
});

describe("isTerminalState", () => {
  it("returns true for completed/failed/canceled/rejected", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("canceled")).toBe(true);
    expect(isTerminalState("rejected")).toBe(true);
  });

  it("returns false for non-terminal states", () => {
    expect(isTerminalState("submitted")).toBe(false);
    expect(isTerminalState("working")).toBe(false);
    expect(isTerminalState("input-required")).toBe(false);
    expect(isTerminalState("auth-required")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm test -- test/a2a.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Append helpers to `src/a2a.ts`**

Append to the bottom of `src/a2a.ts`:

```ts
// ============================================================
// SSE helpers
// ============================================================

/** Format any JSON-serializable value as a single SSE `data:` event. */
export function formatSseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Parse a single SSE line. Returns null for comments, blanks, and non-data lines. */
export function parseSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(6));
  } catch {
    return null;
  }
}

/**
 * Build a v1.0 TaskStatusUpdateEvent with state=failed. Used by the SSE proxy
 * to surface upstream failures to downstream consumers. v1.0 removed the
 * `final` field; terminality is inferred via isTerminalState().
 */
export function buildFailedStatusEvent(
  taskId: string,
  contextId: string,
  reason: string,
): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: {
        messageId: `err-${taskId}`,
        role: "agent",
        parts: [{ kind: "text", text: reason }],
      },
    },
  };
}

// ============================================================
// Terminality
// ============================================================

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

/**
 * True if the given TaskState ends the task (v1.0 terminality rule).
 * v1.0 removed the explicit `final` field from status events; use this
 * helper wherever the old code would have checked `event.final`.
 */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test -- test/a2a.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/a2a.ts test/a2a.test.ts
git commit -m "feat(a2a): add SSE and terminality helpers"
```

---

## Task 4: Add extension-header helpers to `a2a.ts`

**Files:**
- Modify: `src/a2a.ts` (append)
- Modify: `test/a2a.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `test/a2a.test.ts`:

```ts
import {
  parseExtensionsHeader,
  formatExtensionsHeader,
  declareExtension,
} from "../src/a2a.js";

describe("parseExtensionsHeader", () => {
  it("splits comma-separated URIs and trims", () => {
    expect(parseExtensionsHeader("https://a/ext1, https://b/ext2")).toEqual([
      "https://a/ext1",
      "https://b/ext2",
    ]);
  });

  it("handles single value", () => {
    expect(parseExtensionsHeader("https://x/ext")).toEqual(["https://x/ext"]);
  });

  it("returns [] for undefined/empty", () => {
    expect(parseExtensionsHeader(undefined)).toEqual([]);
    expect(parseExtensionsHeader("")).toEqual([]);
    expect(parseExtensionsHeader("   ")).toEqual([]);
  });
});

describe("formatExtensionsHeader", () => {
  it("joins URIs with comma-space", () => {
    expect(formatExtensionsHeader(["https://a", "https://b"])).toBe("https://a, https://b");
  });

  it("returns empty string for empty array", () => {
    expect(formatExtensionsHeader([])).toBe("");
  });
});

describe("declareExtension", () => {
  it("builds a minimal Extension object", () => {
    expect(declareExtension("https://x/ext1")).toEqual({ uri: "https://x/ext1" });
  });

  it("includes description and required if provided", () => {
    expect(
      declareExtension("https://x/ext1", {
        description: "test",
        required: true,
      }),
    ).toEqual({
      uri: "https://x/ext1",
      description: "test",
      required: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm test -- test/a2a.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Append helpers to `src/a2a.ts`**

Append to the bottom of `src/a2a.ts`:

```ts
// ============================================================
// Extension header carriage (v1.0)
// ============================================================

/**
 * Parse an X-A2A-Extensions request/response header value into a list of
 * extension URIs. Tolerates whitespace and returns [] on missing/blank input.
 */
export function parseExtensionsHeader(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Format a list of extension URIs for emitting as X-A2A-Extensions. */
export function formatExtensionsHeader(uris: string[]): string {
  return uris.join(", ");
}

/**
 * Construct an Extension declaration for inclusion in
 * AgentCard.capabilities.extensions.
 */
export function declareExtension(
  uri: string,
  opts: { description?: string; required?: boolean; params?: Record<string, unknown> } = {},
): Extension {
  const ext: Extension = { uri };
  if (opts.description !== undefined) ext.description = opts.description;
  if (opts.required !== undefined) ext.required = opts.required;
  if (opts.params !== undefined) ext.params = opts.params;
  return ext;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test -- test/a2a.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/a2a.ts test/a2a.test.ts
git commit -m "feat(a2a): add X-A2A-Extensions header helpers"
```

---

## Task 5: Migrate `errors.ts` to v1.0 lowercase enums

**Files:**
- Modify: `src/errors.ts`
- Modify: `test/errors.test.ts`
- Modify: `test/e2e-rate-limit.test.ts`
- Modify: `test/e2e-handshake.test.ts`

- [ ] **Step 1: Update `test/errors.test.ts` to expect v1.0 lowercase**

Open `test/errors.test.ts`. Replace every occurrence of the uppercase strings as follows:

- `"TASK_STATE_FAILED"` → `"failed"`
- `"TASK_STATE_REJECTED"` → `"rejected"`

The specific assertions to update:

```ts
// Before
expect(resp.body.status.state).toBe("TASK_STATE_FAILED");
// After
expect(resp.body.status.state).toBe("failed");
```

```ts
// Before
expect(resp.body.status.state).toBe("TASK_STATE_REJECTED");
// After
expect(resp.body.status.state).toBe("rejected");
```

Apply to all five describe blocks in the file. No other changes.

- [ ] **Step 2: Run errors.test.ts to confirm it fails**

Run: `pnpm test -- test/errors.test.ts`
Expected: FAIL — `expected 'failed' to be 'TASK_STATE_FAILED'` (etc.).

- [ ] **Step 3: Update `src/errors.ts` — replace verbose enum strings**

In `src/errors.ts`, find the five `buildErrorResponse(...)` calls and update the `state` string argument:

```ts
// rateLimitResponse — change "TASK_STATE_FAILED" → "failed"
export function rateLimitResponse(retryAfterSeconds: number, taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    429,
    "failed",
    `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    { "Retry-After": String(retryAfterSeconds) },
    taskId,
  );
}

// notFriendResponse — change "TASK_STATE_REJECTED" → "rejected"
export function notFriendResponse(taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "rejected",
    "You are not authorized. Send a CONNECTION_REQUEST to establish a friendship first.",
    {},
    taskId,
  );
}

// agentNotFoundResponse — change "TASK_STATE_FAILED" → "failed"
export function agentNotFoundResponse(tenant: string, taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    404,
    "failed",
    `Agent "${tenant}" not found on this server.`,
    {},
    taskId,
  );
}

// agentScopeDeniedResponse — change "TASK_STATE_REJECTED" → "rejected"
export function agentScopeDeniedResponse(tenant: string, taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "rejected",
    `You are not authorized to access agent "${tenant}".`,
    {},
    taskId,
  );
}

// agentTimeoutResponse — change "TASK_STATE_FAILED" → "failed"
export function agentTimeoutResponse(tenant: string, timeoutSeconds: number, taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    504,
    "failed",
    `Agent "${tenant}" did not respond within ${timeoutSeconds} seconds.`,
    {},
    taskId,
  );
}
```

- [ ] **Step 4: Run errors.test.ts**

Run: `pnpm test -- test/errors.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Update `test/e2e-rate-limit.test.ts`**

Search for uppercase enum references. Replace:
- `"TASK_STATE_FAILED"` → `"failed"`

Run: `pnpm test -- test/e2e-rate-limit.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Update `test/e2e-handshake.test.ts`**

Search for `"TASK_STATE_REJECTED"` in the `it("rejects normal requests from unknown agents", ...)` test:

```ts
// Before
expect(data.status.state).toBe("TASK_STATE_REJECTED");
// After
expect(data.status.state).toBe("rejected");
```

Do **not** touch the handshake-accepted test yet (that asserts on handshake.ts output, which we migrate in Task 7).

Run: `pnpm test -- test/e2e-handshake.test.ts`
Expected: the "rejects normal requests" test now passes; the "accepts CONNECTION_REQUEST" / "persisted new friend" / "allows normal requests after friending" tests will still pass because they check `"TASK_STATE_COMPLETED"` from handshake.ts (not yet migrated).

- [ ] **Step 7: Run full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/errors.ts test/errors.test.ts test/e2e-rate-limit.test.ts test/e2e-handshake.test.ts
git commit -m "refactor(errors): v1.0 lowercase TaskState enums"
```

---

## Task 6: Migrate `streaming.ts` to use `a2a.ts` and drop `final`

**Files:**
- Modify: `src/streaming.ts`
- Modify: `src/server.ts` (swap `buildFailedEvent` import to `buildFailedStatusEvent` from a2a.ts)
- Modify: `test/streaming.test.ts`
- Modify: `test/streaming-e2e.test.ts`

- [ ] **Step 1: Update `test/streaming.test.ts` to expect v1.0 event**

Open `test/streaming.test.ts`. The current `buildFailedEvent` tests assert on the old shape. Replace the import and the `describe("buildFailedEvent"` block:

Top of file (imports):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTimeoutController,
  formatSSEEvent,
  parseSSELine,
} from "../src/streaming.js";
```

Delete the `describe("buildFailedEvent", ...)` block entirely — that function moves to `a2a.ts` and is covered by `test/a2a.test.ts::buildFailedStatusEvent`. (The file keeps the `formatSSEEvent`, `parseSSELine`, `createTimeoutController` blocks.)

- [ ] **Step 2: Run streaming.test.ts to see it still passes (no migration yet)**

Run: `pnpm test -- test/streaming.test.ts`
Expected: the remaining tests pass. (`buildFailedEvent` block is gone.)

- [ ] **Step 3: Update `src/streaming.ts`**

Replace `src/streaming.ts` contents entirely:

```ts
import type { Response as ExpressResponse } from "express";
import {
  formatSseEvent,
  parseSseLine,
  buildFailedStatusEvent,
} from "./a2a.js";

// Re-export the SSE primitives so callers that want them through this file
// keep working, but all new code should import directly from ./a2a.js.
export const formatSSEEvent = formatSseEvent;
export const parseSSELine = parseSseLine;

export function createTimeoutController(
  timeoutMs: number,
  onTimeout: () => void,
): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function start() {
    timer = setTimeout(onTimeout, timeoutMs);
  }

  function reset() {
    if (timer !== null) clearTimeout(timer);
    start();
  }

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  start();
  return { reset, clear };
}

export function initSSEResponse(res: ExpressResponse): {
  write: (event: unknown) => void;
  end: () => void;
} {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  return {
    write: (event: unknown) => {
      res.write(formatSseEvent(event));
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

export async function proxySSEStream(opts: {
  upstreamResponse: Response;
  downstream: ExpressResponse;
  timeoutMs: number;
  taskId: string;
  contextId: string;
}): Promise<void> {
  const { upstreamResponse, downstream, timeoutMs, taskId, contextId } = opts;

  const sse = initSSEResponse(downstream);
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  let closeResolve: () => void = () => {};
  const closePromise = new Promise<{ done: true; value: undefined }>((resolve) => {
    closeResolve = () => resolve({ done: true, value: undefined });
  });

  const timeoutCtrl = createTimeoutController(timeoutMs, () => {
    if (closed) return;
    sse.write(
      buildFailedStatusEvent(
        taskId,
        contextId,
        "Stream timed out — no data received within timeout period",
      ),
    );
    cleanup();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    timeoutCtrl.clear();
    if (reader) {
      reader.cancel().catch(() => {});
    }
    sse.end();
    closeResolve();
  }

  downstream.on("close", () => cleanup());

  const body = upstreamResponse.body;
  if (!body) {
    sse.write(buildFailedStatusEvent(taskId, contextId, "Upstream returned no stream body"));
    cleanup();
    return;
  }

  reader = body.getReader();
  const activeReader = reader;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!closed) {
      const result = await Promise.race([activeReader.read(), closePromise]);
      if (result.done) break;

      timeoutCtrl.reset();

      buffer += decoder.decode(result.value as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (closed) break;
        if (line.trim()) {
          downstream.write(line + "\n");
        } else {
          downstream.write("\n");
        }
      }
    }
  } catch {
    if (!closed) {
      sse.write(buildFailedStatusEvent(taskId, contextId, "Upstream stream broke unexpectedly"));
    }
  } finally {
    try {
      activeReader.releaseLock();
    } catch {}
    cleanup();
  }
}

```

- [ ] **Step 4: Update `src/server.ts` import**

Find the import line at the top of `src/server.ts`:

```ts
// Before
import { proxySSEStream, buildFailedEvent, initSSEResponse } from "./streaming.js";
// After
import { proxySSEStream, initSSEResponse } from "./streaming.js";
import { buildFailedStatusEvent } from "./a2a.js";
```

Then grep the file for `buildFailedEvent(` call sites and rename each to `buildFailedStatusEvent(`. The arguments don't change.

- [ ] **Step 5: Update `test/streaming-e2e.test.ts`**

Search for `"TASK_STATE_FAILED"` and `final: true` references. Replace:

- `"TASK_STATE_FAILED"` → `"failed"`
- Remove any `.final` assertions (e.g., `expect(event.final).toBe(true)` lines — delete the line entirely).

- [ ] **Step 6: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/streaming.ts src/server.ts test/streaming.test.ts test/streaming-e2e.test.ts
git commit -m "refactor(streaming): use a2a.ts helpers; drop v0.3 'final' field"
```

---

## Task 7: Migrate `handshake.ts` to v1.0 `Message` response

**Files:**
- Modify: `src/handshake.ts`
- Modify: `test/handshake.test.ts`
- Modify: `test/e2e-handshake.test.ts`

- [ ] **Step 1: Update `test/handshake.test.ts` to expect v1.0 Message shape**

In `test/handshake.test.ts`, replace the first two describe blocks:

```ts
describe("buildAcceptedResponse", () => {
  it("returns a v1.0 Message with accepted extension metadata", () => {
    const response = buildAcceptedResponse();

    expect(response.messageId).toMatch(/.+/);
    expect(response.role).toBe("agent");
    expect(response.parts[0]).toEqual({ kind: "text", text: "Connection accepted" });
    expect(
      response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "accepted" });
  });
});

describe("buildDeniedResponse", () => {
  it("returns a v1.0 Message with denied extension metadata", () => {
    const response = buildDeniedResponse("Not accepting connections");

    expect(response.messageId).toMatch(/.+/);
    expect(response.role).toBe("agent");
    expect(response.parts[0]).toEqual({ kind: "text", text: "Connection denied" });
    expect(
      response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "denied", reason: "Not accepting connections" });
  });
});
```

- [ ] **Step 2: Run handshake.test.ts to confirm failure**

Run: `pnpm test -- test/handshake.test.ts`
Expected: FAIL — response shape mismatch.

- [ ] **Step 3: Update `src/handshake.ts` — response shape**

Replace the top portion of `src/handshake.ts`:

```ts
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { CONNECTION_EXTENSION_URL } from "./middleware.js";
import type { Message } from "./a2a.js";
import type {
  ConnectionRequestConfig,
  ConnectionRequest,
  FriendsConfig,
} from "./types.js";

// The handshake response is a v1.0 Message with the connection-extension
// metadata attached. Callers expose it as the body of a message:send reply.
type ConnectionResponse = Message;

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
  pendingRequestsPath?: string;
}

interface HandleConnectionRequestResult {
  response: ConnectionResponse;
  newFriend?: NewFriend;
}

export function buildAcceptedResponse(): ConnectionResponse {
  return {
    messageId: uuidv4(),
    role: "agent",
    parts: [{ kind: "text", text: "Connection accepted" }],
    metadata: {
      [CONNECTION_EXTENSION_URL]: { type: "accepted" },
    },
  };
}

export function buildDeniedResponse(reason: string): ConnectionResponse {
  return {
    messageId: uuidv4(),
    role: "agent",
    parts: [{ kind: "text", text: "Connection denied" }],
    metadata: {
      [CONNECTION_EXTENSION_URL]: { type: "denied", reason },
    },
  };
}
```

Leave the rest of `handshake.ts` (`deriveHandle`, `storePendingRequest`, `loadPendingRequests`, `handleConnectionRequest`) unchanged — those functions don't emit wire enums.

- [ ] **Step 4: Run handshake.test.ts**

Run: `pnpm test -- test/handshake.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Update `test/e2e-handshake.test.ts`**

Find the "accepts a CONNECTION_REQUEST" test. Its assertions currently check for the Task-like response. Update them to match the Message shape:

```ts
// Before
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

// After
const data = (await response.json()) as {
  messageId: string;
  role: string;
  parts: Array<{ kind: string; text: string }>;
  metadata: Record<string, Record<string, string>>;
};
expect(data.role).toBe("agent");
expect(data.parts[0].text).toBe("Connection accepted");
expect(
  data.metadata["https://tidepool.dev/ext/connection/v1"].type,
).toBe("accepted");
```

- [ ] **Step 6: Update `test/discovery-e2e.test.ts` similarly**

Find the "Alice sends CONNECTION_REQUEST" test. Update the assertion block from the Task shape to the Message shape (same pattern as Step 5).

```ts
// Before
const data = (await response.json()) as {
  status: { state: string };
  artifacts: Array<{ metadata: Record<string, Record<string, string>> }>;
};
expect(data.status.state).toBe("TASK_STATE_COMPLETED");
expect(
  data.artifacts[0].metadata["https://tidepool.dev/ext/connection/v1"]
    .type,
).toBe("accepted");

// After
const data = (await response.json()) as {
  messageId: string;
  role: string;
  parts: Array<{ kind: string; text: string }>;
  metadata: Record<string, Record<string, string>>;
};
expect(data.role).toBe("agent");
expect(data.metadata["https://tidepool.dev/ext/connection/v1"].type).toBe("accepted");
```

- [ ] **Step 7: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/handshake.ts test/handshake.test.ts test/e2e-handshake.test.ts test/discovery-e2e.test.ts
git commit -m "refactor(handshake): v1.0 Message response shape"
```

---

## Task 8: Migrate `agent-card.ts` to v1.0 shape

**Files:**
- Modify: `src/agent-card.ts`
- Modify: `test/agent-card.test.ts`
- Modify: `test/agent-card-rich.test.ts`
- Modify: `test/cli-ping.test.ts`
- Modify: `src/ping.ts`

- [ ] **Step 1: Update `test/agent-card.test.ts` to match v1.0**

Open `test/agent-card.test.ts`. Update the `buildLocalAgentCard` test:

```ts
describe("buildLocalAgentCard", () => {
  it("builds a v1.0 Agent Card for a locally registered agent", () => {
    const card = buildLocalAgentCard({
      name: "rust-expert",
      description: "Expert in Rust and systems programming",
      publicUrl: "https://example.com:9900",
      tenant: "rust-expert",
    });

    expect(card.name).toBe("rust-expert");
    expect(card.description).toBe("Expert in Rust and systems programming");
    expect(card.version).toBe("1.0.0");
    expect(card.url).toBe("https://example.com:9900/rust-expert");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
    expect(card.capabilities.streaming).toBe(true);
    // v1.0: no stateTransitionHistory
    expect((card.capabilities as any).stateTransitionHistory).toBeUndefined();
    // v1.0: extensions declared under capabilities
    expect(card.capabilities.extensions).toBeDefined();
    expect(card.capabilities.extensions?.[0]?.uri).toBe(
      "https://tidepool.dev/ext/connection/v1",
    );
    // v1.0 securitySchemes shape: { type: "mtls" }
    expect(card.securitySchemes.mtls).toEqual({
      type: "mtls",
      description: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- test/agent-card.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/agent-card.ts` to v1.0**

Replace `src/agent-card.ts` contents:

```ts
import {
  AgentCardSchema,
  declareExtension,
} from "./a2a.js";
import type { AgentCard } from "./a2a.js";
import { CONNECTION_EXTENSION_URL } from "./middleware.js";
import type { RemoteAgent } from "./types.js";

export type { AgentCard };

interface BuildLocalOpts {
  name: string;
  description: string;
  publicUrl: string;
  tenant: string;
}

export function buildLocalAgentCard(opts: BuildLocalOpts): AgentCard {
  return {
    name: opts.name,
    description: opts.description,
    url: `${opts.publicUrl}/${opts.tenant}`,
    version: "1.0.0",
    skills: [
      {
        id: "chat",
        name: "chat",
        description: opts.description,
        tags: [],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [
        declareExtension(CONNECTION_EXTENSION_URL, {
          description: "Tidepool peer friending handshake",
          required: false,
        }),
      ],
    },
    securitySchemes: {
      mtls: {
        type: "mtls",
        description: "mTLS with self-signed certificates. Identity is cert fingerprint.",
      },
    },
    securityRequirements: [{ mtls: [] }],
  };
}

interface BuildRemoteOpts {
  remote: RemoteAgent;
  localUrl: string;
  description: string;
}

/**
 * Fetch a peer's Agent Card over plain HTTPS with no fingerprint pinning.
 *
 * Initial card discovery happens BEFORE the peer's fingerprint is known
 * (the card itself is what you use to decide whether to friend them).
 * Pinning here would be chicken-and-egg. Post-friending interactions — A2A
 * messages and any authenticated card refresh — go through
 * buildPinnedDispatcher, which does enforce fingerprint equality.
 */
export async function fetchRemoteAgentCard(
  url: string,
): Promise<AgentCard | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();

    const parsed = AgentCardSchema.safeParse(data);
    if (!parsed.success) return null;

    return parsed.data as unknown as AgentCard;
  } catch {
    return null;
  }
}

interface BuildRichRemoteOpts {
  remote: RemoteAgent;
  localUrl: string;
  remoteCard: AgentCard | null;
}

export function buildRichRemoteAgentCard(opts: BuildRichRemoteOpts): AgentCard {
  const { remote, localUrl, remoteCard } = opts;

  if (!remoteCard) {
    return buildRemoteAgentCard({
      remote,
      localUrl,
      description: `Remote agent: ${remote.localHandle}`,
    });
  }

  return {
    name: remote.localHandle,
    description: remoteCard.description,
    url: `${localUrl}/${remote.localHandle}`,
    version: remoteCard.version,
    skills: remoteCard.skills,
    defaultInputModes: remoteCard.defaultInputModes,
    defaultOutputModes: remoteCard.defaultOutputModes,
    capabilities: remoteCard.capabilities,
    // The local interface is plain HTTP on 127.0.0.1 — local agents talk to
    // their own Tidepool without credentials. We deliberately drop the
    // remote card's mTLS scheme so local agents don't try to present client
    // certs when calling localhost. mTLS happens server-to-server on the
    // public interface, handled transparently by the Tidepool proxy.
    securitySchemes: {},
    securityRequirements: [],
  };
}

export function buildRemoteAgentCard(opts: BuildRemoteOpts): AgentCard {
  return {
    name: opts.remote.localHandle,
    description: opts.description,
    url: `${opts.localUrl}/${opts.remote.localHandle}`,
    version: "1.0.0",
    skills: [
      {
        id: "chat",
        name: "chat",
        description: opts.description,
        tags: [],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    securitySchemes: {},
    securityRequirements: [],
  };
}
```

- [ ] **Step 4: Run agent-card.test.ts**

Run: `pnpm test -- test/agent-card.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Update `test/agent-card-rich.test.ts` if any `stateTransitionHistory` or old-security assertions exist**

Open the file, grep for `stateTransitionHistory`, `mutualTlsSecurityScheme`, and uppercase enum strings. Delete or update any matching assertions to match the v1.0 shape.

- [ ] **Step 6: Update `src/ping.ts` to use the new AgentCardSchema**

Replace `src/ping.ts` contents:

```ts
import { AgentCardSchema } from "./a2a.js";

export interface PingResult {
  reachable: boolean;
  name?: string;
  description?: string;
  skills?: { id: string; name: string; description: string }[];
  latencyMs?: number;
  error?: string;
}

export async function pingAgent(agentCardUrl: string): Promise<PingResult> {
  const start = Date.now();

  try {
    const response = await fetch(agentCardUrl, {
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    const parsed = AgentCardSchema.safeParse(data);

    if (!parsed.success) {
      return {
        reachable: false,
        latencyMs,
        error: "Response is not a valid Agent Card (missing name)",
      };
    }

    return {
      reachable: true,
      name: parsed.data.name,
      description: parsed.data.description,
      skills: parsed.data.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      reachable: false,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export function formatPingResult(url: string, result: PingResult): string {
  const lines: string[] = [];

  if (result.reachable) {
    lines.push(`REACHABLE  ${result.name} (${result.latencyMs}ms)`);
    lines.push(`  URL: ${url}`);
    if (result.description) {
      lines.push(`  Description: ${result.description}`);
    }
    if (result.skills && result.skills.length > 0) {
      lines.push(`  Skills:`);
      for (const skill of result.skills) {
        lines.push(`    - ${skill.name}: ${skill.description}`);
      }
    }
  } else {
    lines.push(`UNREACHABLE  ${url}`);
    if (result.error) lines.push(`  Error: ${result.error}`);
    if (result.latencyMs !== undefined) {
      lines.push(`  Latency: ${result.latencyMs}ms`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 7: Update `test/cli-ping.test.ts` mock agent payloads to v1.0**

Find the reachable mock card. Update the capabilities block:

```ts
// Before
capabilities: {
  streaming: true,
  pushNotifications: false,
  stateTransitionHistory: false,
},
// After
capabilities: {
  streaming: true,
  pushNotifications: false,
},
```

No other changes needed (skill shape is v1.0-compatible).

- [ ] **Step 8: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/agent-card.ts src/ping.ts test/agent-card.test.ts test/agent-card-rich.test.ts test/cli-ping.test.ts
git commit -m "refactor(agent-card): v1.0 shape, extensions declaration, mtls security scheme"
```

---

## Task 9: Add `X-A2A-Extensions` header support

**Files:**
- Modify: `src/middleware.ts`
- Modify: `src/server.ts`
- Modify: `test/middleware.test.ts`

- [ ] **Step 1: Update `test/middleware.test.ts` — add cases for header detection**

Open `test/middleware.test.ts`. Find the `describe("isConnectionRequest", ...)` block. Update the function signature assertions and add new cases:

```ts
import { isConnectionRequest, CONNECTION_EXTENSION_URL } from "../src/middleware.js";

// Existing tests: update call sites from isConnectionRequest(body) to
// isConnectionRequest(body, headers). For cases that don't care about
// headers, pass {} explicitly.

describe("isConnectionRequest", () => {
  const connectionRequestBody = {
    message: {
      messageId: "cr-1",
      role: "user",
      parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
      extensions: [CONNECTION_EXTENSION_URL],
      metadata: {
        [CONNECTION_EXTENSION_URL]: {
          type: "request",
          reason: "test",
          agent_card_url: "http://example.com/card.json",
        },
      },
    },
  };

  it("returns true when extension URI is in message.extensions", () => {
    expect(isConnectionRequest(connectionRequestBody, {})).toBe(true);
  });

  it("returns true when extension URI is only in X-A2A-Extensions header", () => {
    const bodyWithoutExt = {
      message: {
        ...connectionRequestBody.message,
        extensions: [],
      },
    };
    expect(
      isConnectionRequest(bodyWithoutExt, {
        "x-a2a-extensions": CONNECTION_EXTENSION_URL,
      }),
    ).toBe(true);
  });

  it("returns false when neither signal declares the extension", () => {
    const bodyNoExt = {
      message: {
        messageId: "x",
        role: "user",
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
      },
    };
    expect(isConnectionRequest(bodyNoExt, {})).toBe(false);
  });

  it("returns false when body is malformed", () => {
    expect(isConnectionRequest(null, {})).toBe(false);
    expect(isConnectionRequest({}, {})).toBe(false);
  });

  it("returns false when first part text is not CONNECTION_REQUEST", () => {
    const bodyWrong = {
      message: {
        messageId: "x",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        extensions: [CONNECTION_EXTENSION_URL],
      },
    };
    expect(isConnectionRequest(bodyWrong, {})).toBe(false);
  });
});
```

Any additional existing tests in the file that call `isConnectionRequest(body)` must be updated to `isConnectionRequest(body, {})`.

- [ ] **Step 2: Run middleware.test.ts to confirm failures**

Run: `pnpm test -- test/middleware.test.ts`
Expected: FAIL — signature mismatch / header detection missing.

- [ ] **Step 3: Update `src/middleware.ts`**

Replace `isConnectionRequest` and leave the rest of the file as-is:

```ts
/**
 * Check if an inbound A2A request is a CONNECTION_REQUEST.
 *
 * Per v1.0, clients MAY signal an extension via `message.extensions[]` AND/OR
 * the `X-A2A-Extensions` request header. We treat either signal as sufficient
 * and additionally require the first text part to be "CONNECTION_REQUEST".
 */
export function isConnectionRequest(
  body: unknown,
  headers: Record<string, unknown>,
): boolean {
  if (!body || typeof body !== "object") return false;

  const msg = (body as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return false;

  const message = msg as Record<string, unknown>;

  const inBodyExtensions = Array.isArray(message.extensions)
    ? (message.extensions as string[])
    : [];

  // `X-A2A-Extensions` header — express normalizes header names to lowercase.
  const headerRaw = headers["x-a2a-extensions"];
  const headerValue = typeof headerRaw === "string" ? headerRaw : undefined;
  const inHeaderExtensions = headerValue
    ? headerValue.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const declaresExtension =
    inBodyExtensions.includes(CONNECTION_EXTENSION_URL) ||
    inHeaderExtensions.includes(CONNECTION_EXTENSION_URL);

  if (!declaresExtension) return false;

  const parts = message.parts as Array<Record<string, string>> | undefined;
  if (!parts || !Array.isArray(parts) || parts.length === 0) return false;

  return parts[0].text === "CONNECTION_REQUEST";
}
```

- [ ] **Step 4: Run middleware.test.ts**

Run: `pnpm test -- test/middleware.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Update `src/server.ts` — pass headers; emit X-A2A-Extensions on handshake response**

In `src/server.ts`:

Find the call site:

```ts
if (isConnectionRequest(req.body)) {
```

Change to:

```ts
if (isConnectionRequest(req.body, req.headers)) {
```

Find the `res.json(result.response)` call inside the handshake handler (where we return `buildAcceptedResponse` / `buildDeniedResponse`). Just before that line, set the response header:

```ts
res.setHeader("X-A2A-Extensions", "https://tidepool.dev/ext/connection/v1");
res.json(result.response);
```

Also, in the catch-all 504 path (search for `uuidv4()`-id literal error shape further down), update the `state` string from any remaining `"TASK_STATE_FAILED"` to `"failed"`. The literal block to replace:

```ts
// Before
res.status(504).json({
  id: messageId ?? uuidv4(),
  status: { state: "TASK_STATE_FAILED" },
  artifacts: [
    { artifactId: "error", parts: [{ kind: "text", text: message }] },
  ],
});
// After
res.status(504).json({
  id: messageId ?? uuidv4(),
  status: { state: "failed" },
  artifacts: [
    { artifactId: "error", parts: [{ kind: "text", text: message }] },
  ],
});
```

Apply to both occurrences (public interface 504 branch, local interface 504 branch).

- [ ] **Step 6: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/server.ts test/middleware.test.ts
git commit -m "feat(server): X-A2A-Extensions header carriage on request/response"
```

---

## Task 10: Update remaining e2e tests to use v1.0 shapes in mocks

**Files:**
- Modify: `test/e2e.test.ts`
- Modify: `test/mTLS-pinning.test.ts`
- Modify: `test/discovery-e2e.test.ts`
- Modify: `test/streaming-e2e.test.ts`

These tests have mock agents returning responses with verbose enum strings. We update both the mock payloads AND the assertions so our end-to-end wire is v1.0.

- [ ] **Step 1: Update `test/e2e.test.ts`**

Find `createMockAgent`. Replace the response body:

```ts
// Before
res.json({
  id: `task-${name}`,
  contextId: `ctx-${name}`,
  status: { state: "TASK_STATE_COMPLETED" },
  artifacts: [ ... ],
});
// After — no enum change in shape, just rename state
res.json({
  id: `task-${name}`,
  contextId: `ctx-${name}`,
  status: { state: "completed" },
  artifacts: [ ... ],
});
```

Find each assertion:

```ts
// Before
expect(data.status.state).toBe("TASK_STATE_COMPLETED");
// After
expect(data.status.state).toBe("completed");
```

Find the message bodies sent in tests. Replace `role: "ROLE_USER"` with `role: "user"`.

- [ ] **Step 2: Update `test/mTLS-pinning.test.ts`**

Same pattern. Grep the file for:
- `"TASK_STATE_COMPLETED"` → `"completed"`
- `"ROLE_USER"` → `"user"`
- `"ROLE_AGENT"` → `"agent"`

Also the mock agent there emits `state: "TASK_STATE_COMPLETED"` — update to `"completed"`.

- [ ] **Step 3: Update `test/discovery-e2e.test.ts`**

Same pattern. Grep for the same enum strings and replace.

- [ ] **Step 4: Update `test/streaming-e2e.test.ts`**

This test's mock agent emits streaming events. Grep for:
- `state: "TASK_STATE_WORKING"` → `state: "working"`
- `state: "TASK_STATE_COMPLETED"` → `state: "completed"`
- `state: "TASK_STATE_FAILED"` → `state: "failed"`
- `"ROLE_USER"` → `"user"`
- `"ROLE_AGENT"` → `"agent"`
- Any `final: true` or `final: false` lines on emitted events — delete the lines.

Update assertions in the same way.

- [ ] **Step 5: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/e2e.test.ts test/mTLS-pinning.test.ts test/discovery-e2e.test.ts test/streaming-e2e.test.ts
git commit -m "test: migrate e2e mocks and assertions to A2A v1.0 shape"
```

---

## Task 11: Slim `types.ts` — delete A2A types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Replace `src/types.ts` contents**

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
}

export interface StaticPeer {
  endpoint: string;
  agentCardUrl: string;
  description?: string;
}

export interface DiscoveryConfig {
  providers: string[];
  cacheTtlSeconds: number;
  mdns?: {
    enabled: boolean;
  };
  directory?: {
    enabled: boolean;
    url: string;
  };
  static?: {
    peers: Record<string, StaticPeer>;
  };
}

export interface AgentConfig {
  localEndpoint: string;
  rateLimit: string;
  description: string;
  timeoutSeconds: number;
}

export interface FriendEntry {
  fingerprint: string;
  agents?: string[];
}

export interface FriendsConfig {
  friends: Record<string, FriendEntry>;
}

export interface RemoteAgent {
  localHandle: string;
  remoteEndpoint: string;
  remoteTenant: string;
  certFingerprint: string;
}

export interface AgentIdentity {
  name: string;
  certPath: string;
  keyPath: string;
  fingerprint: string;
}

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

Deleted: `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `StreamEvent`. These now live in `src/a2a.ts`.

- [ ] **Step 2: Run typecheck to find any remaining callers**

Run: `pnpm typecheck`
Expected: zero errors. If any file still imports `TaskStatusUpdateEvent` etc. from `./types.js`, the typecheck will tell you; update that file's import to `./a2a.js`. (After Tasks 1–10 this should be zero.)

- [ ] **Step 3: Run full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "refactor(types): remove A2A wire types (moved to a2a.ts)"
```

---

## Task 12: Slim `schemas.ts` — delete wire-shape schemas

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/discovery/directory-provider.ts` (only if it imports wire schemas from here)

- [ ] **Step 1: Replace `src/schemas.ts` contents**

Keep only the config + discovery schemas. Delete `AgentCardSchema` (moved to `a2a.ts`) and `PingResponseSchema` (replaced by `AgentCardSchema` in `a2a.ts`).

```ts
import { z } from "zod";

/**
 * Zod schemas for Tidepool-specific structures (server config, friends
 * config, directory responses). A2A wire-shape schemas live in a2a.ts.
 */

// --- Shared atoms ---

const RateLimitString = z.string().min(1);

// --- ServerConfig ---

const AgentConfigSchema = z.object({
  localEndpoint: z.string().min(1),
  rateLimit: RateLimitString.default("50/hour"),
  description: z.string().default(""),
  timeoutSeconds: z.number().positive().default(30),
});

const ConnectionRequestAutoSchema = z.object({
  model: z.string(),
  apiKeyEnv: z.string(),
  policy: z.string(),
});

const ConnectionRequestConfigSchema = z.object({
  mode: z.enum(["accept", "deny", "auto"]).default("deny"),
  auto: ConnectionRequestAutoSchema.optional(),
});

const StaticPeerSchema = z.object({
  endpoint: z.string().min(1),
  agentCardUrl: z.string().optional(),
  agent_card_url: z.string().optional(),
  description: z.string().optional(),
}).transform((v) => ({
  endpoint: v.endpoint,
  agentCardUrl: (v.agentCardUrl ?? v.agent_card_url) as string,
  description: v.description,
}));

const DiscoveryConfigSchema = z.object({
  providers: z.array(z.string()).default(["static"]),
  cacheTtlSeconds: z.number().positive().default(300),
  mdns: z.object({ enabled: z.boolean() }).optional(),
  directory: z
    .object({ enabled: z.boolean(), url: z.string().min(1) })
    .optional(),
  static: z
    .object({ peers: z.record(z.string(), StaticPeerSchema) })
    .optional(),
});

export const ServerConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(9900),
    host: z.string().default("0.0.0.0"),
    localPort: z.number().int().positive().default(9901),
    rateLimit: RateLimitString.default("100/hour"),
    streamTimeoutSeconds: z.number().positive().default(300),
  }),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  connectionRequests: ConnectionRequestConfigSchema.default({ mode: "deny" }),
  discovery: DiscoveryConfigSchema.default({
    providers: ["static"],
    cacheTtlSeconds: 300,
  }),
});

// --- FriendsConfig ---

const FriendEntrySchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  agents: z.array(z.string()).optional(),
});

export const FriendsConfigSchema = z.object({
  friends: z.record(z.string(), FriendEntrySchema).default({}),
});

// --- DiscoveredAgent (from our directory — not the A2A spec) ---

export const DiscoveredAgentSchema = z.object({
  handle: z.string().min(1),
  description: z.string().default(""),
  endpoint: z.string().min(1),
  agentCardUrl: z.string().min(1),
  status: z.enum(["online", "offline"]),
});

export const DirectorySearchResponseSchema = z.object({
  agents: z.array(DiscoveredAgentSchema),
});
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: zero errors. If any file imports `AgentCardSchema` or `PingResponseSchema` from `./schemas.js`, fix the import path to `./a2a.js`. (After Tasks 1–10 this should be zero, but verify.)

- [ ] **Step 3: Run full suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/schemas.ts
git commit -m "refactor(schemas): remove A2A wire schemas (moved to a2a.ts)"
```

---

## Task 13: Final sweep and Agent Card conformance test

**Files:**
- Modify (verify): all `src/` and `test/` files
- Modify: `test/agent-card.test.ts` (add conformance test)

- [ ] **Step 1: Grep for any surviving verbose dialect**

Run:
```bash
grep -rn "TASK_STATE_\|ROLE_USER\|ROLE_AGENT\|final:\s*true\|stateTransitionHistory\|mutualTlsSecurityScheme" src/ test/ bin/ 2>&1 | grep -v "\.d\.ts"
```
Expected: 0 matches.

If any matches remain, update them in place. Specific fixes:
- `TASK_STATE_X` → lowercase `x` (strip prefix, lowercase)
- `ROLE_USER` / `ROLE_AGENT` → `user` / `agent`
- `final: true` or `final: false` lines in event literals → delete the line
- `stateTransitionHistory` in capabilities → delete the key
- `mutualTlsSecurityScheme` nested shape → flatten to `{ type: "mtls", description: "..." }`

- [ ] **Step 2: Add Agent Card conformance integration test**

Append to `test/agent-card.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { AgentCardSchema } from "../src/a2a.js";

describe("v1.0 conformance: Agent Card emitted by the server validates against AgentCardSchema", () => {
  let tmpDir: string;
  let server: { close: () => void };
  let clientCert: Buffer;
  let clientKey: Buffer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-card-conformance-"));
    const configDir = path.join(tmpDir, "host");
    fs.mkdirSync(path.join(configDir, "agents/probe"), { recursive: true });

    await generateIdentity({
      name: "probe",
      certPath: path.join(configDir, "agents/probe/identity.crt"),
      keyPath: path.join(configDir, "agents/probe/identity.key"),
    });

    // A separate identity to present as the client when we GET the card over
    // mTLS — content of the cert doesn't matter; the request just needs to
    // complete the TLS handshake.
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
          port: 57700,
          host: "0.0.0.0",
          localPort: 57701,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          probe: {
            localEndpoint: "http://127.0.0.1:57702",
            rateLimit: "50/hour",
            description: "probe",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
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

  it("parses as a valid v1.0 AgentCard", async () => {
    const res = await fetch("https://127.0.0.1:57700/probe/.well-known/agent-card.json", {
      // @ts-expect-error — undici dispatcher for mTLS
      dispatcher: new UndiciAgent({
        connect: {
          cert: clientCert,
          key: clientKey,
          rejectUnauthorized: false,
        },
      }),
    });
    expect(res.ok).toBe(true);

    const card = await res.json();
    const parsed = AgentCardSchema.safeParse(card);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      // Declared our extension
      expect(parsed.data.capabilities.extensions).toBeDefined();
      expect(parsed.data.capabilities.extensions?.[0]?.uri).toBe(
        "https://tidepool.dev/ext/connection/v1",
      );
      // v1.0 does NOT have stateTransitionHistory on capabilities
      expect((parsed.data.capabilities as any).stateTransitionHistory).toBeUndefined();
      // mtls scheme uses v1.0 tagged-union shape
      expect(parsed.data.securitySchemes.mtls).toMatchObject({ type: "mtls" });
    }
  });
});
```

- [ ] **Step 3: Run full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass. New conformance test passes.

- [ ] **Step 4: Confirm grep returns 0 matches**

Run:
```bash
grep -rn "TASK_STATE_\|ROLE_USER\|ROLE_AGENT\|final:\s*true\|stateTransitionHistory\|mutualTlsSecurityScheme" src/ test/ bin/ 2>&1 | grep -v "\.d\.ts"
```
Expected: no output.

- [ ] **Step 5: Final commit**

```bash
git add test/agent-card.test.ts
git commit -m "test(a2a): v1.0 Agent Card conformance check"
```

---

## Verification (run after every task)

```bash
pnpm typecheck && pnpm test
```

Both must pass. Mid-migration tasks may fail briefly between step 3 and step 4 of a task — that's expected (TDD red → green). The task is only complete when the final commit step is green.

## Explicitly deferred (future follow-ups, NOT part of this plan)

The spec's "Data flow and validation" section describes an end-state where **every** inbound A2A request body and **every** upstream SSE event is validated against the `a2a.ts` zod schemas at a single seam in `server.ts` and `streaming.ts`. This plan makes the schemas available and migrates wire shapes but does **not** wire the schemas in as gates. Reason: behavior change risk — strict request validation could reject in-flight peers that emit slightly non-conforming payloads. A follow-up plan should add these validation gates with its own e2e test coverage for malformed-input cases.

Other items deferred:
- Top-level `Task` RPC surface (`tasks/get`, `tasks/list`) — only the type is added; no endpoints.
- Push-notification configs.
- Authenticated extended card flow.
- Vendoring the canonical v1.0 AgentCard JSON schema for a true schema-based conformance check. Until then, `AgentCardSchema` is our conformance check (Task 13).

## Done state

- `pnpm typecheck` clean
- `pnpm test` green, `155 + ~25 new a2a.test.ts tests + 1 conformance = ~181` tests passing
- `grep -rn "TASK_STATE_\|ROLE_\|final:\s*true\|stateTransitionHistory" src/ test/` returns 0 matches
- Agent Card emitted by a running server validates against `AgentCardSchema`
- `src/a2a.ts` is the sole home of A2A wire types and schemas
- `types.ts` holds only Tidepool-specific types
- `schemas.ts` holds only config + directory schemas
