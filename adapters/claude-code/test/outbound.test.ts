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
  it("posts to /:peer/message:send with Origin header and supplied contextId", async () => {
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
      Origin: "http://127.0.0.1:9901",
    });
    expect(((init as RequestInit).headers as Record<string, string>)["X-Agent"]).toBeUndefined();
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

  it("rejects with peer-not-registered on structured peer_not_found error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "peer_not_found", message: `No peer named "bob"` } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
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

  it("rejects with peer-unreachable on structured peer_unreachable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "peer_unreachable", message: `"bob" unreachable` } }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      ),
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

describe("sendOutbound — A2A-native headers", () => {
  it("POSTs without X-Agent, with Origin, to /{peer}/message:send", async () => {
    const captured: { url: string; headers: Record<string, string>; body: any } = {
      url: "", headers: {}, body: null,
    };
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.headers = {} as Record<string, string>;
      const hdrs = (init.headers as any) ?? {};
      for (const [k, v] of Object.entries(hdrs)) captured.headers[k] = String(v);
      captured.body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ id: "t-1", status: { state: "completed" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { sendOutbound } = await import("../src/outbound.js");
    await sendOutbound({
      peer: "bob",
      contextId: "ctx-1",
      text: "hi",
      self: "alice",
      deps: { localPort: 4443, host: "127.0.0.1", fetchImpl: fakeFetch },
    });
    expect(captured.url).toBe("http://127.0.0.1:4443/bob/message:send");
    expect(captured.headers["X-Agent"]).toBeUndefined();
    expect(captured.headers["x-agent"]).toBeUndefined();
    // Origin header present and matches daemon URL
    expect(captured.headers.Origin ?? captured.headers.origin).toBe(
      "http://127.0.0.1:4443",
    );
    expect(captured.body.message.parts[0].text).toBe("hi");
  });

  it("maps structured peer_not_found error to SendError(peer-not-registered)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "peer_not_found",
            message: `No peer named "charlie"`,
            hint: "call list_peers",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { sendOutbound, SendError } = await import("../src/outbound.js");
    await expect(
      sendOutbound({
        peer: "charlie",
        contextId: "ctx-1",
        text: "hi",
        self: "alice",
        deps: { localPort: 4443, host: "127.0.0.1", fetchImpl: fakeFetch },
      }),
    ).rejects.toMatchObject({
      kind: "peer-not-registered",
      hint: "call list_peers",
    });
  });

  it("maps structured peer_unreachable error to SendError(peer-unreachable)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "peer_unreachable",
            message: `"bob" unreachable`,
            hint: "peer may be offline",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { sendOutbound, SendError } = await import("../src/outbound.js");
    await expect(
      sendOutbound({
        peer: "bob",
        contextId: "ctx-1",
        text: "hi",
        self: "alice",
        deps: { localPort: 4443, host: "127.0.0.1", fetchImpl: fakeFetch },
      }),
    ).rejects.toMatchObject({
      kind: "peer-unreachable",
    });
  });

  it("maps structured agent_offline error to SendError(peer-not-registered)", async () => {
    // agent_offline from remote daemon ≈ "peer not currently accepting" from
    // caller's POV. Classify as peer-not-registered for retry/hint purposes.
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "agent_offline",
            message: `"bob" offline`,
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { sendOutbound } = await import("../src/outbound.js");
    await expect(
      sendOutbound({
        peer: "bob",
        contextId: "ctx-1",
        text: "hi",
        self: "alice",
        deps: { localPort: 4443, host: "127.0.0.1", fetchImpl: fakeFetch },
      }),
    ).rejects.toMatchObject({
      kind: "peer-not-registered",
    });
  });
});
