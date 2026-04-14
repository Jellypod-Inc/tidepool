import { describe, expect, it, vi } from "vitest";
import { PendingRegistry } from "../src/pending.js";

describe("PendingRegistry", () => {
  it("resolves a registered task with the provided text", async () => {
    const reg = new PendingRegistry();
    const p = reg.register("t1", 1000);
    expect(reg.size()).toBe(1);
    expect(reg.resolve("t1", "hello")).toBe(true);
    await expect(p).resolves.toBe("hello");
    expect(reg.size()).toBe(0);
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const reg = new PendingRegistry();
    const p = reg.register("t1", 100);
    vi.advanceTimersByTime(200);
    await expect(p).rejects.toThrow(/timeout/);
    expect(reg.size()).toBe(0);
    vi.useRealTimers();
  });

  it("resolve returns false for unknown tasks", () => {
    const reg = new PendingRegistry();
    expect(reg.resolve("nope", "x")).toBe(false);
  });

  it("rejects a registered task explicitly", async () => {
    const reg = new PendingRegistry();
    const p = reg.register("t1", 1000);
    expect(reg.reject("t1", new Error("boom"))).toBe(true);
    await expect(p).rejects.toThrow(/boom/);
    expect(reg.size()).toBe(0);
  });

  it("closeAll rejects every outstanding task", async () => {
    const reg = new PendingRegistry();
    const p1 = reg.register("t1", 1000);
    const p2 = reg.register("t2", 1000);
    reg.closeAll(new Error("shutdown"));
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
    expect(reg.size()).toBe(0);
  });

  it("rejects duplicate registration of the same taskId", () => {
    const reg = new PendingRegistry();
    reg.register("t1", 1000);
    expect(() => reg.register("t1", 1000)).toThrow(/duplicate/);
  });
});
