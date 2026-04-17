import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MAX_TEXT_BYTES, startHttp, type InboundInfo } from "../src/http.js";

describe("startHttp inbound endpoint", () => {
  let server: Awaited<ReturnType<typeof startHttp>>;
  let received: InboundInfo[] = [];

  beforeEach(async () => {
    received = [];
    server = await startHttp({
      port: 0,
      host: "127.0.0.1",
      onInbound: (info) => received.push(info),
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("emits InboundInfo with peer/contextId/messageId/text/parts on POST /message:send", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          metadata: { from: "alice" },
          parts: [{ kind: "text", text: "hello" }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.state).toBe("completed");
    expect(body.contextId).toBe("C1");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      contextId: "C1",
      messageId: "M1",
      peer: "alice",
      text: "hello",
    });
    expect(received[0].parts).toHaveLength(1);
    expect(received[0].parts[0]).toEqual({ kind: "text", text: "hello" });
    expect(received[0].taskId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 400 when message is missing entirely", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("accepts a message with only non-text parts (text becomes empty string)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          metadata: { from: "bob" },
          parts: [{ kind: "data", data: { x: 1 } }],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("");
    expect(received[0].parts).toHaveLength(1);
    expect(received[0].parts[0]).toEqual({ kind: "data", data: { x: 1 } });
  });

  it("parses full A2A Message including structured parts", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m-1",
          contextId: "ctx-1",
          metadata: { from: "bob" },
          parts: [
            { kind: "text", text: "hello" },
            { kind: "data", data: { tags: ["a"] } },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
    expect(received[0].parts).toHaveLength(2);
    expect(received[0].parts[0]).toEqual({ kind: "text", text: "hello" });
    expect(received[0].parts[1]).toEqual({ kind: "data", data: { tags: ["a"] } });
    expect(received[0].peer).toBe("bob");
  });

  it("returns 400 when metadata.from is missing (server-injected — its absence is a bug)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("rejects oversized parts with 413", async () => {
    const big = "x".repeat(MAX_TEXT_BYTES + 1);
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          metadata: { from: "alice" },
          parts: [{ kind: "text", text: big }],
        },
      }),
    });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("extracts participants array from message.metadata.participants", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi all" }],
          metadata: {
            from: "alice",
            participants: ["alice", "bob", "carol"],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].peer).toBe("alice");
    expect(received[0].participants).toEqual(["alice", "bob", "carol"]);
  });

  it("defaults participants to [peer] when metadata.participants is absent", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: { from: "bob" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].participants).toEqual(["bob"]);
  });

  it("ignores malformed participants (non-array or non-string entries)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: { from: "bob", participants: "not-an-array" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].participants).toEqual(["bob"]);
  });

  it("strips non-string entries from participants but keeps valid ones", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: {
            from: "bob",
            participants: ["alice", 42, "bob", "", null],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].participants).toEqual(["alice", "bob"]);
  });

  it("falls back to [peer] when participants array contains only invalid entries", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "M1",
          contextId: "C1",
          parts: [{ kind: "text", text: "hi" }],
          metadata: { from: "bob", participants: [42, null, ""] },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].participants).toEqual(["bob"]);
  });
});
