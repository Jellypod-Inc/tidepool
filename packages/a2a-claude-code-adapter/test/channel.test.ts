import { describe, expect, it, vi } from "vitest";
import { createChannel } from "../src/channel.js";
import { createThreadStore } from "../src/thread-store.js";
import { SendError } from "../src/outbound.js";

function setup(overrides?: {
  send?: (peer: string, text: string, thread?: string) => Promise<{ contextId: string; messageId: string }>;
  listPeers?: () => string[];
  self?: string;
}) {
  const store = createThreadStore({ maxMessagesPerThread: 100, maxThreads: 50 });
  const sent: any[] = [];
  const ch = createChannel({
    self: overrides?.self ?? "alice",
    store,
    listPeers: overrides?.listPeers ?? (() => ["bob", "carol"]),
    send:
      overrides?.send ??
      (async (peer, text, thread) => {
        sent.push({ peer, text, thread });
        return { contextId: thread ?? "ctx-new", messageId: "M-new" };
      }),
  });
  return { ch, store, sent };
}

describe("channel notifyInbound", () => {
  it("emits notifications/claude/channel with the right meta", async () => {
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
    // recorded in store
    expect(store.history("C1")).toHaveLength(1);
    expect(store.history("C1")[0]).toMatchObject({
      from: "bob",
      text: "hello",
      messageId: "M1",
    });
  });
});

describe("channel tool dispatch", () => {
  it("send returns {context_id, message_id} and records outbound", async () => {
    const { ch, store, sent } = setup();
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual({ context_id: "ctx-new", message_id: "M-new" });
    expect(sent).toEqual([{ peer: "bob", text: "hi", thread: undefined }]);
    expect(store.history("ctx-new")).toHaveLength(1);
    expect(store.history("ctx-new")[0]).toMatchObject({
      from: "alice",
      text: "hi",
    });
  });

  it("send with thread reuses contextId", async () => {
    const { ch, sent } = setup();
    await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "follow-up", thread: "ctx-existing" },
    });
    expect(sent[0]).toMatchObject({ thread: "ctx-existing" });
  });

  it("send returns isError result on SendError", async () => {
    const send = vi.fn().mockRejectedValue(
      new SendError(
        "daemon-down",
        "the claw-connect daemon isn't running",
        "run claw-connect claude-code:start",
      ),
    );
    const { ch } = setup({ send });
    const result = await ch.handleToolCall({
      name: "send",
      arguments: { peer: "bob", text: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/daemon isn't running/);
    expect(result.content[0].text).toMatch(/run claw-connect/);
  });

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

  it("list_threads returns store summaries", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peer: "bob",
      messageId: "M1",
      from: "bob",
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
      peer: "bob",
      message_count: 1,
    });
    expect(data.threads[0].last_message_at).toBe(1000);
  });

  it("thread_history returns message list", async () => {
    const { ch, store } = setup();
    store.record({
      contextId: "C1",
      peer: "bob",
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
      ch.handleToolCall({ name: "claw_connect_reply", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });
});
