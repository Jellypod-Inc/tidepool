import { describe, it, expect } from "vitest";
import { TidepoolMetadataSchema, MessageSchema } from "../src/a2a.js";

describe("TidepoolMetadataSchema", () => {
  it("accepts all v1 fields", () => {
    const parsed = TidepoolMetadataSchema.parse({
      from: "alice",
      participants: ["self::a", "did:key:b::x"],
      addressed_to: ["did:key:b::x"],
      in_reply_to: "msg-7",
      self: "alice",
    });
    expect(parsed.addressed_to).toEqual(["did:key:b::x"]);
    expect(parsed.self).toBe("alice");
    expect(parsed.in_reply_to).toBe("msg-7");
  });

  it("rejects wrong types", () => {
    expect(() =>
      TidepoolMetadataSchema.parse({ addressed_to: "not-an-array" }),
    ).toThrow();
    expect(() =>
      TidepoolMetadataSchema.parse({ in_reply_to: 42 }),
    ).toThrow();
    expect(() =>
      TidepoolMetadataSchema.parse({ participants: [1, 2, 3] }),
    ).toThrow();
  });

  it("preserves unknown keys (forward-compat passthrough)", () => {
    const parsed = TidepoolMetadataSchema.parse({
      future_field: "okay",
      other: { nested: true },
    });
    expect((parsed as any).future_field).toBe("okay");
    expect((parsed as any).other).toEqual({ nested: true });
  });

  it("accepts an empty metadata object", () => {
    expect(TidepoolMetadataSchema.parse({})).toEqual({});
  });

  it("Message with new metadata fields validates via MessageSchema", () => {
    const msg = MessageSchema.parse({
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
      metadata: {
        self: "bob",
        addressed_to: ["alice"],
        in_reply_to: "m0",
      },
    });
    expect(msg.metadata?.self).toBe("bob");
    expect(msg.metadata?.addressed_to).toEqual(["alice"]);
  });
});
