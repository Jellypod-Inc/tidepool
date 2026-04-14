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
