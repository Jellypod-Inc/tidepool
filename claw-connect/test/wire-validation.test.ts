import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { validateWire, logWireFailure } from "../src/wire-validation.js";

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

describe("validateWire: union error formatting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A discriminated-ish union where each variant has a `kind` literal.
  const UnionSchema = z.union([
    z.object({ kind: z.literal("a"), value: z.string() }),
    z.object({ kind: z.literal("b"), count: z.number() }),
  ]);

  it("when payload's kind matches one variant, reports only that variant's field errors", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateWire(
      UnionSchema,
      { kind: "a", value: 42 },
      { mode: "enforce", context: "test" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should mention the field that failed inside variant "a".
      expect(result.error).toMatch(/value/);
      // Should NOT collapse to the generic zod union message.
      expect(result.error).not.toMatch(/^\(root\): Invalid input$/);
      expect(result.error.trim()).not.toBe("Invalid input");
    }
  });

  it("when payload has no matching kind, reports a more specific summary than generic Invalid input", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateWire(
      UnionSchema,
      { kind: "c" },
      { mode: "enforce", context: "test" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The summarizer may legitimately pick either variant, but the output
      // MUST be richer than the opaque top-level zod message.
      expect(result.error).not.toBe("(root): Invalid input");
      expect(result.error.length).toBeGreaterThan("Invalid input".length);
    }
  });

  it("prefixes the chosen variant with a [variant …] tag for operator traceability", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateWire(
      UnionSchema,
      { kind: "a", value: 42 },
      { mode: "warn", context: "test" },
    );
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/\[variant [^\]]+\]/);
  });

  it("handles non-discriminated unions (no `kind` on the input) without throwing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const PlainUnion = z.union([
      z.object({ a: z.string() }),
      z.object({ b: z.number() }),
    ]);
    const result = validateWire(
      PlainUnion,
      { a: 1, b: "x" },
      { mode: "enforce", context: "test" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Still produces something more detailed than "Invalid input".
      expect(result.error.length).toBeGreaterThan("Invalid input".length);
    }
  });

  it("does NOT use input's kind as variant tag when no variant declares that kind literal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.union([
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), count: z.number() }),
      // A kind-less variant — analogous to MessageSchema inside StreamEventSchema.
      z.object({ messageId: z.string() }),
    ]);
    const result = validateWire(
      schema,
      { kind: "unknownKind" },
      { mode: "enforce", context: "t" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must NOT carry the bogus [variant unknownKind] tag — "unknownKind" is
      // not declared by any variant. Falls back to a 0-based index tag.
      expect(result.error).not.toMatch(/\[variant unknownKind\]/);
      expect(result.error).toMatch(/\[variant [0-9]+\]/);
    }
    const logged = warn.mock.calls[0]?.[0] as string;
    expect(logged).not.toMatch(/\[variant unknownKind\]/);
  });

  it("uses input's kind as variant tag when a variant declares that kind literal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.union([
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), count: z.number() }),
      z.object({ messageId: z.string() }),
    ]);
    const result = validateWire(
      schema,
      { kind: "a", value: 42 },
      { mode: "enforce", context: "t" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/\[variant a\]/);
      expect(result.error).toMatch(/value/);
    }
    const logged = warn.mock.calls[0]?.[0] as string;
    expect(logged).toMatch(/\[variant a\]/);
  });
});

describe("logWireFailure: log-injection hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes C0 control chars (CR, LF, ESC) in the detail argument", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWireFailure("warn", "ctx", "bad\rpayload\x1b[31m\n");
    const line = warn.mock.calls[0]?.[0] as string;
    // Escaped forms present.
    expect(line).toContain("\\x0d"); // CR
    expect(line).toContain("\\x1b"); // ESC
    expect(line).toContain("\\x0a"); // LF
    // Raw control chars absent.
    expect(line).not.toContain("\r");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\x1b");
    // Result is a single line.
    expect(line.split("\n").length).toBe(1);
  });

  it("leaves normal printable characters untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWireFailure("enforce", "upstream.sse.event", "invalid JSON: {foo: 'bar'}");
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toContain("invalid JSON: {foo: 'bar'}");
  });
});
