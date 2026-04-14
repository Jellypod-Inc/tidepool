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
