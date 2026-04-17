import { describe, expect, it, vi } from "vitest";
import { SendError, sendOutbound } from "../src/outbound.js";

function okAck() {
  return new Response(
    JSON.stringify({
      id: "T-from-peer",
      contextId: "ctx-from-peer",
      status: { state: "completed" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("sendOutbound", () => {
  it("posts to /:peer/message:send with X-Agent header and supplied contextId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      contextId: "C-test",
      text: "hi",
      self: "alice",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9901/bob/message:send");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Agent": "alice",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.message).toMatchObject({
      messageId: result.messageId,
      contextId: "C-test",
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(body.message.metadata).toBeUndefined();
  });

  it("uses caller-supplied contextId in message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      contextId: "ctx-existing",
      text: "hi",
      self: "alice",
      deps: { localPort: 9901, fetchImpl },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.message.contextId).toBe("ctx-existing");
  });

  it("returns a structured error result when daemon is down (ECONNREFUSED)", async () => {
    const err: any = new Error("fetch failed");
    err.cause = { code: "ECONNREFUSED" };
    const fetchImpl = vi.fn().mockRejectedValue(err);
    await expect(
      sendOutbound({
        peer: "bob",
        contextId: "C-test",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "daemon-down" });
  });

  it("rejects with peer-not-registered on 403/404 from server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent not found" }), {
        status: 404,
      }),
    );
    await expect(
      sendOutbound({
        peer: "bob",
        contextId: "C-test",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "peer-not-registered" });
  });

  it("rejects with peer-unreachable on 504 from server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Local agent unreachable" }), {
        status: 504,
      }),
    );
    await expect(
      sendOutbound({
        peer: "bob",
        contextId: "C-test",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "peer-unreachable" });
  });

  it("rejected errors are SendError instances (and Error instances) with stack traces", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("nope", { status: 404 }),
    );
    try {
      await sendOutbound({
        peer: "bob",
        contextId: "C-test",
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      });
      throw new Error("expected send to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SendError);
      expect(err).toBeInstanceOf(Error);
      expect((err as SendError).stack).toBeTruthy();
      expect((err as SendError).name).toBe("SendError");
    }
  });

  it("embeds message.metadata.participants when participants is supplied", async () => {
    let captured: any;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ id: "T1", contextId: "C1", status: { state: "completed" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    await sendOutbound({
      peer: "bob",
      contextId: "C1",
      text: "hi all",
      self: "alice",
      participants: ["alice", "bob", "carol"],
      deps: { localPort: 9901, fetchImpl },
    });
    expect(captured.message.metadata).toEqual({
      participants: ["alice", "bob", "carol"],
    });
  });

  it("omits message.metadata when participants is not supplied", async () => {
    let captured: any;
    const fetchImpl = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ id: "T1", contextId: "C1", status: { state: "completed" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    await sendOutbound({
      peer: "bob",
      contextId: "C1",
      text: "hi",
      self: "alice",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(captured.message).not.toHaveProperty("metadata");
  });
});
