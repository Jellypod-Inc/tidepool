import { describe, expect, it, vi } from "vitest";
import { PendingRegistry } from "../src/pending.js";
import { createChannel } from "../src/channel.js";

function makeChannel(overrides?: {
  listPeers?: () => string[];
  send?: (peer: string, text: string) => Promise<{ taskId: string }>;
  self?: string;
}) {
  const reg = new PendingRegistry();
  return {
    reg,
    ...createChannel({
      registry: reg,
      self: overrides?.self ?? "alice",
      listPeers: overrides?.listPeers ?? (() => ["bob", "carol"]),
      send:
        overrides?.send ??
        (async () => ({ taskId: "00000000-0000-0000-0000-000000000000" })),
    }),
  };
}

describe("createChannel", () => {
  it("notifyInbound sends a notifications/claude/channel event", async () => {
    const { server, notifyInbound } = makeChannel();

    const calls: any[] = [];
    (server as any).notification = async (n: unknown) => {
      calls.push(n);
    };

    await notifyInbound({
      taskId: "abc123",
      contextId: "ctx1",
      messageId: "m1",
      text: "hello",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello",
        meta: { task_id: "abc123" },
      },
    });
  });

  it("claw_connect_reply resolves the pending task", async () => {
    const { reg, handleToolCall } = makeChannel();
    const pending = reg.register("t1", 1000);

    const result = await handleToolCall({
      name: "claw_connect_reply",
      arguments: { task_id: "t1", text: "hi back" },
    });

    expect(result.content[0].text).toContain("sent");
    await expect(pending).resolves.toBe("hi back");
  });

  it("claw_connect_reply returns an error when task_id is unknown", async () => {
    const { handleToolCall } = makeChannel();
    const result = await handleToolCall({
      name: "claw_connect_reply",
      arguments: { task_id: "nope", text: "orphan" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown task/i);
  });

  it("rejects unknown tools", async () => {
    const { handleToolCall } = makeChannel();
    await expect(
      handleToolCall({ name: "not_a_tool", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("claw_connect_reply rejects invalid input", async () => {
    const { handleToolCall } = makeChannel();
    const result = await handleToolCall({
      name: "claw_connect_reply",
      arguments: { task_id: "", text: 123 as unknown as string },
    });
    expect(result.isError).toBe(true);
  });

  it("claw_connect_whoami returns this agent's handle", async () => {
    const { handleToolCall } = makeChannel({ self: "alice" });
    const result = await handleToolCall({
      name: "claw_connect_whoami",
      arguments: {},
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ handle: "alice" });
  });

  it("claw_connect_list_peers returns uniform {handle} shape, no locality", async () => {
    const { handleToolCall } = makeChannel({
      listPeers: () => ["bob", "carol"],
    });
    const result = await handleToolCall({
      name: "claw_connect_list_peers",
      arguments: {},
    });
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      peers: [{ handle: "bob" }, { handle: "carol" }],
    });
    // locality must not leak
    for (const p of body.peers) {
      expect(p).not.toHaveProperty("kind");
      expect(p).not.toHaveProperty("fingerprint");
      expect(p).not.toHaveProperty("endpoint");
    }
  });

  it("claw_connect_send invokes the sender and returns a task_id", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ taskId: "11111111-2222-3333-4444-555555555555" });
    const { handleToolCall } = makeChannel({ send });

    const result = await handleToolCall({
      name: "claw_connect_send",
      arguments: { peer: "bob", text: "hi" },
    });
    expect(send).toHaveBeenCalledWith("bob", "hi");
    const body = JSON.parse(result.content[0].text);
    expect(body.task_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("claw_connect_send rejects empty peer or text", async () => {
    const { handleToolCall } = makeChannel();
    const bad = await handleToolCall({
      name: "claw_connect_send",
      arguments: { peer: "", text: "hi" },
    });
    expect(bad.isError).toBe(true);
    const bad2 = await handleToolCall({
      name: "claw_connect_send",
      arguments: { peer: "bob", text: "" },
    });
    expect(bad2.isError).toBe(true);
  });
});
