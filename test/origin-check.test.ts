import { describe, it, expect } from "vitest";
import { isOriginAllowed, isHostAllowed } from "../src/origin-check.js";

describe("isOriginAllowed", () => {
  it("allows missing Origin header (non-browser clients)", () => {
    expect(isOriginAllowed(undefined, 4443)).toBe(true);
  });

  it("allows null origin (e.g., file:// or data: contexts)", () => {
    expect(isOriginAllowed("null", 4443)).toBe(true);
  });

  it("allows http://localhost:<port>", () => {
    expect(isOriginAllowed("http://localhost:4443", 4443)).toBe(true);
  });

  it("allows http://127.0.0.1:<port>", () => {
    expect(isOriginAllowed("http://127.0.0.1:4443", 4443)).toBe(true);
  });

  it("rejects a different port on localhost", () => {
    expect(isOriginAllowed("http://localhost:5555", 4443)).toBe(false);
  });

  it("rejects non-localhost origins", () => {
    expect(isOriginAllowed("http://evil.example", 4443)).toBe(false);
  });

  it("rejects https:// on localhost (loopback shouldn't need TLS)", () => {
    expect(isOriginAllowed("https://localhost:4443", 4443)).toBe(false);
  });
});

describe("isHostAllowed", () => {
  it("allows 127.0.0.1:<port>", () => {
    expect(isHostAllowed("127.0.0.1:4443", 4443)).toBe(true);
  });

  it("allows localhost:<port>", () => {
    expect(isHostAllowed("localhost:4443", 4443)).toBe(true);
  });

  it("rejects external hostnames", () => {
    expect(isHostAllowed("tidepool.example:4443", 4443)).toBe(false);
  });

  it("rejects wrong port", () => {
    expect(isHostAllowed("127.0.0.1:5555", 4443)).toBe(false);
  });
});
