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

  it("emits InboundInfo with peer/contextId/messageId/text on POST /message:send", async () => {
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
    expect(received[0].taskId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 400 when message.parts[0].text is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { messageId: "M1", contextId: "C1" } }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
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

  it("rejects oversized text with 413", async () => {
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
});
