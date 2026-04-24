import { describe, it, expect, beforeEach } from "vitest";
import { ThreadIndex } from "../src/thread-index.js";

describe("ThreadIndex", () => {
  let idx: ThreadIndex;
  beforeEach(() => { idx = new ThreadIndex({ maxThreads: 3, maxIdsPerThread: 3 }); });

  it("records and checks ids within a thread", () => {
    idx.record("ctx1", "m1");
    idx.record("ctx1", "m2");
    expect(idx.has("ctx1", "m1")).toBe("present");
    expect(idx.has("ctx1", "m2")).toBe("present");
    expect(idx.has("ctx1", "never")).toBe("absent");
  });

  it("returns unknown for a thread we've never seen", () => {
    expect(idx.has("brand-new", "x")).toBe("unknown");
  });

  it("evicts oldest thread when over capacity", () => {
    idx.record("a", "x");
    idx.record("b", "x");
    idx.record("c", "x");
    idx.record("d", "x"); // evicts "a"
    expect(idx.has("a", "x")).toBe("unknown");
    expect(idx.has("d", "x")).toBe("present");
  });

  it("evicts oldest id within a thread when over per-thread cap", () => {
    idx.record("a", "1");
    idx.record("a", "2");
    idx.record("a", "3");
    idx.record("a", "4"); // evicts "1"
    expect(idx.has("a", "1")).toBe("absent"); // thread known; id specifically absent
    expect(idx.has("a", "4")).toBe("present");
  });

  it("updates thread recency on record", () => {
    idx.record("a", "1");
    idx.record("b", "1");
    idx.record("c", "1");
    idx.record("a", "2"); // bumps "a" to most-recent
    idx.record("d", "1"); // evicts "b" (oldest), not "a"
    expect(idx.has("a", "1")).toBe("present");
    expect(idx.has("b", "1")).toBe("unknown");
  });
});
