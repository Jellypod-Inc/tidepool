import { describe, expect, it, vi } from "vitest";
import { sendOutbound } from "../src/outbound.js";

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
  it("posts to /:peer/message:send with X-Agent header and a fresh contextId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      text: "hi",
      self: "alice",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(result.contextId).toMatch(/^[0-9a-f-]{36}$/);
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
      contextId: result.contextId,
      parts: [{ kind: "text", text: "hi" }],
    });
    expect(body.message.metadata).toBeUndefined();
  });

  it("reuses caller-supplied thread id as contextId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okAck());
    const result = await sendOutbound({
      peer: "bob",
      text: "hi",
      self: "alice",
      thread: "ctx-existing",
      deps: { localPort: 9901, fetchImpl },
    });
    expect(result.contextId).toBe("ctx-existing");
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
        text: "hi",
        self: "alice",
        deps: { localPort: 9901, fetchImpl },
      }),
    ).rejects.toMatchObject({ kind: "peer-unreachable" });
  });
});
