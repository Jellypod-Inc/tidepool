import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenBucket, parseRateLimit } from "../src/rate-limiter.js";

describe("parseRateLimit", () => {
  it("parses 'N/hour' format", () => {
    const result = parseRateLimit("100/hour");
    expect(result).toEqual({ tokens: 100, windowMs: 3_600_000 });
  });

  it("parses '50/hour' format", () => {
    const result = parseRateLimit("50/hour");
    expect(result).toEqual({ tokens: 50, windowMs: 3_600_000 });
  });

  it("parses '10/minute' format", () => {
    const result = parseRateLimit("10/minute");
    expect(result).toEqual({ tokens: 10, windowMs: 60_000 });
  });

  it("throws on invalid format", () => {
    expect(() => parseRateLimit("bad")).toThrow();
    expect(() => parseRateLimit("100/year")).toThrow();
    expect(() => parseRateLimit("0/hour")).toThrow();
  });
});

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests within the limit", () => {
    const bucket = new TokenBucket(5, 3_600_000);

    for (let i = 0; i < 5; i++) {
      const result = bucket.consume();
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects requests over the limit", () => {
    const bucket = new TokenBucket(3, 3_600_000);

    bucket.consume();
    bucket.consume();
    bucket.consume();

    const result = bucket.consume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("refills tokens over time", () => {
    const bucket = new TokenBucket(2, 60_000);

    bucket.consume();
    bucket.consume();
    expect(bucket.consume().allowed).toBe(false);

    vi.advanceTimersByTime(30_000);

    const result = bucket.consume();
    expect(result.allowed).toBe(true);
  });

  it("never exceeds max tokens after long idle", () => {
    const bucket = new TokenBucket(5, 60_000);

    bucket.consume();
    bucket.consume();

    vi.advanceTimersByTime(600_000);

    for (let i = 0; i < 5; i++) {
      expect(bucket.consume().allowed).toBe(true);
    }
    expect(bucket.consume().allowed).toBe(false);
  });

  it("returns correct retryAfterSeconds", () => {
    const bucket = new TokenBucket(10, 3_600_000);

    for (let i = 0; i < 10; i++) {
      bucket.consume();
    }

    const result = bucket.consume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(360);
  });

  it("reports remaining tokens", () => {
    const bucket = new TokenBucket(5, 60_000);

    expect(bucket.remaining()).toBe(5);
    bucket.consume();
    expect(bucket.remaining()).toBe(4);
    bucket.consume();
    bucket.consume();
    expect(bucket.remaining()).toBe(2);
  });
});
