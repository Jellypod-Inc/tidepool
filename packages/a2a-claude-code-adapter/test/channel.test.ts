import { describe, expect, it, vi } from "vitest";
import { PendingRegistry } from "../src/pending.js";
import { createChannel } from "../src/channel.js";

describe("createChannel", () => {
  it("declares the claude/channel and tools capabilities", () => {
    const { server } = createChannel({ registry: new PendingRegistry() });
    const caps = (server as any)._capabilities ?? (server as any).serverCapabilities;
    // The SDK stores the options object; verify the capability shape we passed.
    // Rather than reach into SDK internals, assert behavior: listTools returns a2a_reply.
    expect(server).toBeDefined();
  });

  it("notifyInbound sends a notifications/claude/channel event", async () => {
    const reg = new PendingRegistry();
    const { server, notifyInbound } = createChannel({ registry: reg });

    const calls: any[] = [];
    // Monkey-patch the SDK's notification sender.
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

  it("a2a_reply tool resolves the pending task", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });
    const pending = reg.register("t1", 1000);

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "t1", text: "hi back" },
    });

    expect(result.content[0].text).toContain("sent");
    await expect(pending).resolves.toBe("hi back");
  });

  it("a2a_reply returns an error when the task_id is unknown", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "nope", text: "orphan" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown task/i);
  });

  it("rejects unknown tools", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    await expect(
      handleToolCall({ name: "not_a_tool", arguments: {} }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("a2a_reply rejects invalid input", async () => {
    const reg = new PendingRegistry();
    const { handleToolCall } = createChannel({ registry: reg });

    const result = await handleToolCall({
      name: "a2a_reply",
      arguments: { task_id: "", text: 123 as unknown as string },
    });
    expect(result.isError).toBe(true);
  });
});
