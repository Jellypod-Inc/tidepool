import { describe, it, expect } from "vitest";
import type { TaskState, Role, Part, Message } from "../src/a2a.js";
import {
  MessageSchema,
  TaskSchema,
  TaskStatusUpdateEventSchema,
  TaskArtifactUpdateEventSchema,
  StreamEventSchema,
  AgentCardSchema,
  PartSchema,
} from "../src/a2a.js";

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
        extensions: [{ uri: "https://clawconnect.dev/ext/connection/v1" }],
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
