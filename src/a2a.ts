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

// ----- Part -----

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

// ----- Stream events -----

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

export const TidepoolMetadataSchema = z
  .object({
    from: z.string().optional(),
    participants: z.array(z.string()).optional(),
    addressed_to: z.array(z.string()).optional(),
    in_reply_to: z.string().optional(),
    self: z.string().optional(),
  })
  .loose();

export const MessageSchema = z
  .object({
    messageId: z.string().min(1),
    role: RoleSchema,
    parts: z.array(PartSchema),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    extensions: z.array(z.string()).optional(),
    metadata: TidepoolMetadataSchema.optional(),
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

// ============================================================
// SSE helpers
// ============================================================

/** Format any JSON-serializable value as a single SSE `data:` event. */
export function formatSseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Discriminated result for SSE line parsing. `skip` covers comments, blanks,
 * and non-`data:` headers (e.g. `event: …`); `data` carries a successfully
 * parsed JSON payload; `invalid-json` carries the raw payload for a `data:`
 * line whose JSON failed to parse — callers can then decide whether to reject
 * (enforce) or pass through (warn).
 */
export type SseLineParse =
  | { kind: "skip" }
  | { kind: "data"; value: unknown }
  | { kind: "invalid-json"; raw: string };

/** Parse a single SSE line into a 3-state discriminated result. */
export function parseSseLine(line: string): SseLineParse {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) {
    return { kind: "skip" };
  }
  const payload = trimmed.slice(6);
  try {
    return { kind: "data", value: JSON.parse(payload) };
  } catch {
    return { kind: "invalid-json", raw: payload };
  }
}

/** Build a TaskStatusUpdateEvent with state=failed to signal upstream errors. */
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

/** True if the given TaskState ends the task. */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

// ============================================================
// Extension header carriage
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
