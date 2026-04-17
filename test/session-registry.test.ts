import { describe, it, expect, vi } from "vitest";
import { createSessionRegistry } from "../src/session/registry.js";

describe("createSessionRegistry", () => {
  it("registers a new session and returns sessionId", () => {
    const reg = createSessionRegistry();
    const result = reg.register("alice", {
      endpoint: "http://127.0.0.1:12345",
      card: { description: "test" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.name).toBe("alice");
      expect(result.session.endpoint).toBe("http://127.0.0.1:12345");
      expect(result.session.sessionId).toBeTruthy();
      expect(result.session.registeredAt).toBeInstanceOf(Date);
    }
  });

  it("rejects a second registration for the same name", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:12345", card: {} });
    const result = reg.register("alice", {
      endpoint: "http://127.0.0.1:54321",
      card: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("conflict");
    }
  });

  it("allows re-registration after deregister", () => {
    const reg = createSessionRegistry();
    const first = reg.register("alice", {
      endpoint: "http://127.0.0.1:12345",
      card: {},
    });
    expect(first.ok).toBe(true);
    if (first.ok) reg.deregister(first.session.sessionId);
    const second = reg.register("alice", {
      endpoint: "http://127.0.0.1:54321",
      card: {},
    });
    expect(second.ok).toBe(true);
  });

  it("get returns the active session for a name", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:12345", card: {} });
    const session = reg.get("alice");
    expect(session?.endpoint).toBe("http://127.0.0.1:12345");
  });

  it("get returns undefined for an unregistered name", () => {
    const reg = createSessionRegistry();
    expect(reg.get("charlie")).toBeUndefined();
  });

  it("list returns all current sessions", () => {
    const reg = createSessionRegistry();
    reg.register("alice", { endpoint: "http://127.0.0.1:1", card: {} });
    reg.register("bob", { endpoint: "http://127.0.0.1:2", card: {} });
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(["alice", "bob"]);
  });

  it("deregister is idempotent on unknown sessionId", () => {
    const reg = createSessionRegistry();
    expect(() => reg.deregister("does-not-exist")).not.toThrow();
  });

  it("fires onChange callback when sessions are added or removed", () => {
    const cb = vi.fn();
    const reg = createSessionRegistry();
    reg.onChange(cb);
    const r = reg.register("alice", { endpoint: "http://127.0.0.1:1", card: {} });
    expect(cb).toHaveBeenCalledTimes(1);
    if (r.ok) reg.deregister(r.session.sessionId);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
