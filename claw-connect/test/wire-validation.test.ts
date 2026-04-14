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
