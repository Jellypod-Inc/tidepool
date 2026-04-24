import { describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channel.js";
import { createThreadStore } from "../src/thread-store.js";
import { BroadcastError, type BroadcastResponse } from "../src/outbound.js";

type BroadcastArgs = {
  peers: string[];
  text: string;
  thread?: string;
  addressed_to?: string[];
  in_reply_to?: string;
};

function makeBroadcastResponse(peers: string[], overrides?: Partial<BroadcastResponse>): BroadcastResponse {
  return {
    context_id: overrides?.context_id ?? "ctx-default",
    message_id: overrides?.message_id ?? "msg-default",
    results: overrides?.results ?? peers.map((peer) => ({ peer, delivery: "accepted" as const })),
  };
}

function setup(overrides?: {
  broadcast?: (args: BroadcastArgs) => Promise<BroadcastResponse>;
  listPeers?: () => Promise<string[]>;
  self?: string;
}) {
  const store = createThreadStore({ maxMessagesPerThread: 100, maxThreads: 50 });
  const broadcasts: BroadcastArgs[] = [];
  let counter = 0;
  const ch = createChannel({
    self: overrides?.self ?? "alice",
    store,
    listPeers: overrides?.listPeers ?? (async () => ["bob", "carol"]),
    broadcast:
      overrides?.broadcast ??
      (async (args) => {
        broadcasts.push(args);
        counter++;
        return makeBroadcastResponse(args.peers, {
          context_id: args.thread ?? `ctx-${counter}`,
          message_id: `msg-${counter}`,
        });
      }),
  });
  return { ch, store, broadcasts };
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
      self: "alice",
      participants: ["bob"],
      parts: [],
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
      self: "wolverine",
      participants: ["alice", "wolverine", "bobby"],
      parts: [],
      text: "hi all",
    });
    expect(calls[0].params.meta.participants).toBe("alice wolverine bobby");
    // Store records every non-self participant (alice, bobby).
    const summaries = store.listThreads();
    expect(summaries[0].peers).toEqual(["alice", "bobby"]);
  });

  it("renders self, addressed_to, in_reply_to on the channel tag", async () => {
    const { ch } = setup({ self: "bob" });
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "t",
      contextId: "c",
      messageId: "m",
      peer: "alice",
      self: "bob",
      participants: ["alice", "bob", "carol"],
      addressedTo: ["bob"],
      inReplyTo: "m-prev",
      parts: [],
      text: "hi",
    });
    expect(calls).toHaveLength(1);
    const meta = calls[0].params.meta;
    expect(meta.self).toBe("bob");
    expect(meta.participants).toBe("alice bob carol");
    expect(meta.addressed_to).toBe("bob");
    expect(meta.in_reply_to).toBe("m-prev");
  });

  it("omits self/addressed_to/in_reply_to when not set", async () => {
    const { ch } = setup({ self: "bob" });
    const calls: any[] = [];
    (ch.server as any).notification = async (n: unknown) => {
      calls.push(n);
    };
    await ch.notifyInbound({
      taskId: "t",
      contextId: "c",
      messageId: "m",
      peer: "alice",
      self: "", // pre-v1 sender — daemon did not stamp self
      participants: ["alice", "bob"],
      parts: [],
      text: "hi",
    });
    expect(calls).toHaveLength(1);
    const meta = calls[0].params.meta;
    expect(meta.self).toBeUndefined();
    expect(meta.addressed_to).toBeUndefined();
    expect(meta.in_reply_to).toBeUndefined();
  });
});

describe("channel tool dispatch — send", () => {
  it("pairwise: peers:[bob] calls broadcast once, returns context_id + message_id + results", async () => {
    const { ch, store, broadcasts } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.context_id).toBe("string");
    expect(data.context_id.length).toBeGreaterThan(0);
    expect(typeof data.message_id).toBe("string");
    expect(data.message_id.length).toBeGreaterThan(0);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ peer: "bob", delivery: "accepted" });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].peers).toEqual(["bob"]);
    expect(broadcasts[0].text).toBe("hi");
    // No participants stamping — daemon handles it
    expect(broadcasts[0]).not.toHaveProperty("participants");
    expect(store.history(data.context_id)).toHaveLength(1);
    expect(store.history(data.context_id)[0]).toMatchObject({
      from: "alice",
      text: "hi",
    });
  });

  it("multi-peer: peers:[bob,carol] calls broadcast once with both peers", async () => {
    const { ch, store, broadcasts } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi all" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(data.results.map((r: any) => r.peer)).toEqual(["bob", "carol"]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].peers).toEqual(["bob", "carol"]);
    // Thread store has one record with both peers.
    const summaries = store.listThreads();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].peers).toEqual(["bob", "carol"]);
    expect(summaries[0].messageCount).toBe(1);
  });

  it("send with thread passes thread to broadcast", async () => {
    const { ch, broadcasts } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "follow-up", thread: "ctx-existing" },
    });
    expect(broadcasts[0].thread).toBe("ctx-existing");
  });

  it("dedupes duplicate peers in the input", async () => {
    const { ch, broadcasts } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "bob", "carol"], text: "hi" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(2);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].peers.sort()).toEqual(["bob", "carol"]);
  });

  it("passes addressed_to and in_reply_to to broadcast", async () => {
    const { ch, broadcasts } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: {
        peers: ["bob", "carol"],
        text: "hi bob",
        addressed_to: ["bob"],
        in_reply_to: "msg-prev",
      },
    });
    expect(broadcasts[0].addressed_to).toEqual(["bob"]);
    expect(broadcasts[0].in_reply_to).toBe("msg-prev");
  });

  it("partial failure: some peers failed — overall success, results reflect delivery", async () => {
    const broadcastFn = vi.fn(async (args: BroadcastArgs): Promise<BroadcastResponse> => ({
      context_id: "ctx-partial",
      message_id: "msg-partial",
      results: [
        { peer: "bob", delivery: "accepted" as const },
        { peer: "carol", delivery: "failed" as const, reason: { kind: "peer-not-registered" as const, message: "no agent named \"carol\"" } },
      ],
    }));
    const { ch } = setup({ broadcast: broadcastFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0]).toMatchObject({ peer: "bob", delivery: "accepted" });
    expect(data.results[1]).toMatchObject({ peer: "carol", delivery: "failed" });
  });

  it("all-failed: isError true when all results are failed", async () => {
    const broadcastFn = vi.fn(async (): Promise<BroadcastResponse> => ({
      context_id: "ctx-fail",
      message_id: "msg-fail",
      results: [
        { peer: "bob", delivery: "failed" as const, reason: { kind: "daemon-down" as const, message: "down" } },
        { peer: "carol", delivery: "failed" as const, reason: { kind: "daemon-down" as const, message: "down" } },
      ],
    }));
    const { ch } = setup({ broadcast: broadcastFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(result.isError).toBe(true);
  });

  it("all-failed: does NOT record anything in the thread store", async () => {
    const broadcastFn = vi.fn(async (): Promise<BroadcastResponse> => ({
      context_id: "ctx-fail",
      message_id: "msg-fail",
      results: [
        { peer: "bob", delivery: "failed" as const, reason: { kind: "daemon-down" as const, message: "down" } },
        { peer: "carol", delivery: "failed" as const, reason: { kind: "daemon-down" as const, message: "down" } },
      ],
    }));
    const { ch, store } = setup({ broadcast: broadcastFn });
    await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob", "carol"], text: "hi" },
    });
    expect(store.listThreads()).toHaveLength(0);
  });

  it("BroadcastError from broadcast returns isError result (not a throw)", async () => {
    const broadcastFn = vi.fn(async () => {
      throw new BroadcastError(0, { code: "daemon-down" }, "daemon not reachable on loopback");
    });
    const { ch } = setup({ broadcast: broadcastFn });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "hi" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeDefined();
    expect(data.error.status).toBe(0);
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

  it("response includes shared context_id and message_id at top level", async () => {
    const { ch } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peers: ["bob"], text: "hi" },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("context_id");
    expect(data).toHaveProperty("message_id");
    expect(data).toHaveProperty("results");
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
