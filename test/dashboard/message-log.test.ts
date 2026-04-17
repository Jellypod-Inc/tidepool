import { describe, it, expect } from "vitest";
import { MessageLog } from "../../src/dashboard/message-log.js";

describe("MessageLog", () => {
  it("records a new thread on first message", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads).toHaveLength(1);
    expect(threads[0].contextId).toBe("ctx-1");
    expect(threads[0].participants).toEqual(["alice"]);
    expect(threads[0].messageCount).toBe(1);
  });

  it("accumulates participants and message count", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-1", agent: "bob" });
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads).toHaveLength(1);
    expect(threads[0].participants).toEqual(["alice", "bob"]);
    expect(threads[0].messageCount).toBe(3);
  });

  it("tracks multiple threads independently", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });

    const threads = log.list();
    expect(threads).toHaveLength(2);
  });

  it("evicts oldest thread when capacity is exceeded", () => {
    const log = new MessageLog(2);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });
    log.record({ contextId: "ctx-3", agent: "carol" });

    const threads = log.list();
    expect(threads).toHaveLength(2);
    const ids = threads.map((t) => t.contextId);
    expect(ids).not.toContain("ctx-1");
    expect(ids).toContain("ctx-2");
    expect(ids).toContain("ctx-3");
  });

  it("returns threads sorted by lastActivity descending", () => {
    const log = new MessageLog(100);
    log.record({ contextId: "ctx-1", agent: "alice" });
    log.record({ contextId: "ctx-2", agent: "bob" });
    // Touch ctx-1 again so it's most recent
    log.record({ contextId: "ctx-1", agent: "alice" });

    const threads = log.list();
    expect(threads[0].contextId).toBe("ctx-1");
    expect(threads[1].contextId).toBe("ctx-2");
  });

  it("skips messages with no contextId", () => {
    const log = new MessageLog(100);
    log.record({ contextId: undefined, agent: "alice" });

    expect(log.list()).toHaveLength(0);
  });
});
