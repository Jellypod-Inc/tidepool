import { describe, expect, it } from "vitest";
import { createThreadStore } from "../src/thread-store.js";

describe("createThreadStore", () => {
  it("records a message and lists the thread", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({
      contextId: "C1",
      peer: "bob",
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const threads = s.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      contextId: "C1",
      peer: "bob",
      lastMessageAt: 1000,
      messageCount: 1,
    });
  });

  it("threads are returned newest-last-activity first", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    const threads = s.listThreads();
    expect(threads.map((t) => t.contextId)).toEqual(["C2", "C1"]);
  });

  it("filters threads by peer", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    expect(s.listThreads({ peer: "bob" })).toHaveLength(1);
    expect(s.listThreads({ peer: "bob" })[0].contextId).toBe("C1");
  });

  it("returns thread history in chronological order", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "first", sentAt: 1000 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M2", from: "alice", text: "second", sentAt: 2000 });
    const history = s.history("C1");
    expect(history.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("evicts oldest messages when per-thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 2, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peer: "bob",
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const history = s.history("C1");
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("evicts oldest thread (by last_activity) when thread cap exceeded", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 2 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peer: "dave", messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    const ctxs = s.listThreads().map((t) => t.contextId);
    expect(ctxs).toEqual(["C3", "C2"]);
    expect(s.history("C1")).toEqual([]);
  });

  it("history with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    for (let i = 0; i < 5; i++) {
      s.record({
        contextId: "C1",
        peer: "bob",
        messageId: `M${i}`,
        from: "bob",
        text: `msg${i}`,
        sentAt: 1000 + i,
      });
    }
    const last2 = s.history("C1", { limit: 2 });
    expect(last2.map((m) => m.text)).toEqual(["msg3", "msg4"]);
  });

  it("listThreads with limit returns most recent N", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    s.record({ contextId: "C1", peer: "bob", messageId: "M1", from: "bob", text: "a", sentAt: 1000 });
    s.record({ contextId: "C2", peer: "carol", messageId: "M2", from: "carol", text: "b", sentAt: 2000 });
    s.record({ contextId: "C3", peer: "dave", messageId: "M3", from: "dave", text: "c", sentAt: 3000 });
    expect(s.listThreads({ limit: 2 }).map((t) => t.contextId)).toEqual(["C3", "C2"]);
  });

  it("history of unknown thread returns empty array", () => {
    const s = createThreadStore({ maxMessagesPerThread: 10, maxThreads: 10 });
    expect(s.history("nonexistent")).toEqual([]);
  });
});
