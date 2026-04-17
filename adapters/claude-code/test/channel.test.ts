import { describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channel.js";
import { createThreadStore } from "../src/thread-store.js";
import { SendError } from "../src/outbound.js";

function setup(overrides?: {
  send?: (args: {
    peer: string;
    contextId: string;
    text: string;
    participants?: string[];
  }) => Promise<{ messageId: string }>;
  listPeers?: () => Promise<string[]>;
  self?: string;
}) {
  const store = createThreadStore({ maxMessagesPerThread: 100, maxThreads: 50 });
  const sent: any[] = [];
  let counter = 0;
  const ch = createChannel({
    self: overrides?.self ?? "alice",
    store,
    listPeers: overrides?.listPeers ?? (async () => ["bob", "carol"]),
    send:
      overrides?.send ??
      (async (args) => {
        sent.push(args);
        counter++;
        return { messageId: `M-${counter}` };
      }),
  });
  return { ch, store, sent };
}

describe("channel notifyInbound", () => {
  it("emits notifications/claude/channel with pairwise meta (no participants attr)", async () => {
    const { ch, store } = setup();
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "T1",
      contextId: "C1",
      messageId: "M1",
      peer: "bob",
      participants: ["bob"],
      text: "hello",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello",
        meta: {
          peer: "bob",
          context_id: "C1",
          task_id: "T1",
          message_id: "M1",
        },
      },
    });
    expect(calls[0].params.meta.participants).toBeUndefined();
    expect(store.history("C1")).toHaveLength(1);
    expect(store.history("C1")[0]).toMatchObject({
      from: "bob",
      text: "hello",
      messageId: "M1",
    });
  });

  it("emits participants (space-separated) when multi-party", async () => {
    const { ch, store } = setup({ self: "wolverine" });
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "T1",
      contextId: "C1",
      messageId: "M1",
      peer: "alice",
      participants: ["alice", "wolverine", "bobby"],
      text: "hi all",
    });
    expect(calls[0].params.meta.participants).toBe("alice wolverine bobby");
    // Store records every non-self participant (alice, bobby).
    const summaries = store.listThreads();
    expect(summaries[0].peers).toEqual(["alice", "bobby"]);
  });
});

describe("channel tool dispatch — send", () => {
  it("pairwise: peers:[bob] mints a fresh context, posts once, no participants metadata", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.context_id).toBe("string");
    expect(data.context_id.length).toBeGreaterThan(0);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toEqual({ peer: "bob", message_id: "M-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].peer).toBe("bob");
    expect(sent[0].contextId).toBe(data.context_id);
    expect(sent[0].participants).toBeUndefined();
    expect(store.history(data.context_id)).toHaveLength(1);
    expect(store.history(data.context_id)[0]).toMatchObject({
      from: "alice",
      text: "hi",
    });
  });

  it("multi-peer: peers:[bob,carol] fans out under one contextId with participants [self,bob,carol]", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi all" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.results.map((r: any) => r.peer)).toEqual(["bob", "carol"]);
    expect(sent).toHaveLength(2);
    // Both sends share the same contextId.
    expect(sent[0].contextId).toBe(data.context_id);
    expect(sent[1].contextId).toBe(data.context_id);
    // Both sends carry the same participants list including self.
    expect(sent[0].participants).toEqual(["alice", "bob", "carol"]);
    expect(sent[1].participants).toEqual(["alice", "bob", "carol"]);
    // Thread store has one record with both peers.
    const summaries = store.listThreads();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].peers).toEqual(["bob", "carol"]);
    expect(summaries[0].messageCount).toBe(1);
  });

  it("send with thread reuses the supplied contextId", async () => {
    const { ch, sent } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "follow-up", thread: "ctx-existing" },
    });
    expect(sent[0].contextId).toBe("ctx-existing");
  });

  it("dedupes duplicate peers in the input", async () => {
    const { ch, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "bob", "carol"], text: "hi" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.peer).sort()).toEqual(["bob", "carol"]);
  });

  it("partial failure: one peer fails, others succeed — overall success with error in results", async () => {
    const sendFn = vi.fn(async ({ peer }: any) => {
      if (peer === "carol") {
        throw new SendError(
          "peer-not-registered",
          "no agent named \"carol\" is registered",
          "call list_peers",
        );
      }
      return { messageId: `M-${peer}` };
    });
    const { ch } = setup({ send: sendFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0]).toEqual({ peer: "bob", message_id: "M-bob" });
    expect(data.results[1].peer).toBe("carol");
    expect(data.results[1].error).toMatchObject({
      kind: "peer-not-registered",
      message: expect.stringContaining("carol"),
    });
  });

  it("all-failed: isError true; results contains one error per peer", async () => {
    const sendFn = vi.fn(async () => {
      throw new SendError("daemon-down", "daemon is down", "run serve");
    });
    const { ch } = setup({ send: sendFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.results.every((r: any) => r.error)).toBe(true);
  });

  it("all-failed: does NOT record anything in the thread store", async () => {
    const sendFn = vi.fn(async () => {
      throw new SendError("daemon-down", "daemon is down", "run serve");
    });
    const { ch, store } = setup({ send: sendFn });
    await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(store.listThreads()).toHaveLength(0);
  });

  it("rejects empty peers array", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: [], text: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/);
  });
});

describe("channel tool dispatch — other tools", () => {
  it("whoami returns the agent handle", async () => {
    const { ch } = setup({ self: "alice" });
    const result = await ch.handleToolCall({ name: "whoami", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ handle: "alice" });
  });

  it("list_peers returns sorted handle list", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "list_peers",
      arguments: {},
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      peers: [{ handle: "bob" }, { handle: "carol" }],
    });
  });

  it("list_threads returns peers as an array", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob", "carol"],
      messageId: "M1",
      from: "alice",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "list_threads",
      arguments: {},
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]).toMatchObject({
      context_id: "C1",
      peers: ["bob", "carol"],
      message_count: 1,
    });
  });

  it("list_threads filter by peer matches any participant", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob", "carol"],
      messageId: "M1",
      from: "alice",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "list_threads",
      arguments: { peer: "carol" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].context_id).toBe("C1");
  });

  it("thread_history returns message list", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peers: ["bob"],
      messageId: "M1",
      from: "bob",
      text: "hi",
      sentAt: 1000,
    });
    const result = await ch.handleToolCall({
      name: "thread_history",
      arguments: { thread: "C1" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      message_id: "M1",
      from: "bob",
      text: "hi",
      sent_at: 1000,
    });
  });

  it("unknown tool throws", async () => {
    const { ch } = setup();
    await expect(
      ch.handleToolCall({ name: "tidepool_reply", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });
});
