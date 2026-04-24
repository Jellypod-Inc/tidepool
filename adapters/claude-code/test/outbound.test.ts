import { describe, it, expect } from "vitest";
import { sendBroadcast, BroadcastError } from "../src/outbound.js";

describe("sendBroadcast", () => {
  it("serializes body with optional fields", async () => {
    let capturedBody: any;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/message:broadcast$/);
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        context_id: "00000000-0000-4000-8000-000000000001",
        message_id: "00000000-0000-4000-8000-000000000002",
        results: [{ peer: "alice", delivery: "accepted" }],
      }), { status: 200 });
    }) as typeof fetch;

    const resp = await sendBroadcast({
      peers: ["alice", "bob"],
      text: "hi",
      addressed_to: ["alice"],
      in_reply_to: "msg-1",
      deps: { localPort: 8080, sessionId: "s", fetchImpl },
    });

    expect(capturedBody).toEqual({
      peers: ["alice", "bob"],
      text: "hi",
      addressed_to: ["alice"],
      in_reply_to: "msg-1",
    });
    expect(resp.message_id).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("omits optional fields when not provided", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        context_id: "ctx",
        message_id: "msg",
        results: [],
      }), { status: 200 });
    }) as typeof fetch;
    await sendBroadcast({ peers: ["x"], text: "y", deps: { localPort: 1, sessionId: "s", fetchImpl } });
    expect(Object.keys(capturedBody).sort()).toEqual(["peers", "text"]);
  });

  it("includes thread when provided", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ context_id: "ctx", message_id: "msg", results: [] }), { status: 200 });
    }) as typeof fetch;
    await sendBroadcast({ peers: ["x"], text: "y", thread: "thread-1", deps: { localPort: 1, sessionId: "s", fetchImpl } });
    expect(capturedBody.thread).toBe("thread-1");
  });

  it("throws BroadcastError on HTTP 400 with parsed body", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "invalid_addressed_to", detail: { handle: "ghost" } }), { status: 400 })
    ) as typeof fetch;
    await expect(sendBroadcast({
      peers: ["alice"], text: "hi", addressed_to: ["ghost"],
      deps: { localPort: 1, sessionId: "s", fetchImpl },
    })).rejects.toBeInstanceOf(BroadcastError);
  });

  it("throws BroadcastError(status=0, daemon-down) on connection refused", async () => {
    const fetchImpl = (async () => {
      const e: any = new Error("fetch failed");
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    }) as typeof fetch;
    const thrown = await sendBroadcast({
      peers: ["alice"], text: "hi",
      deps: { localPort: 1, sessionId: "s", fetchImpl },
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(BroadcastError);
    expect(thrown.status).toBe(0);
  });

  it("rejects empty peers array", async () => {
    await expect(sendBroadcast({
      peers: [], text: "hi",
      deps: { localPort: 1, sessionId: "s" },
    })).rejects.toBeInstanceOf(BroadcastError);
  });

  it("uses X-Session-Id header", async () => {
    let capturedHeaders: any;
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      capturedHeaders = init!.headers;
      return new Response(JSON.stringify({ context_id: "c", message_id: "m", results: [] }), { status: 200 });
    }) as typeof fetch;
    await sendBroadcast({ peers: ["x"], text: "y", deps: { localPort: 1, sessionId: "SESSION-123", fetchImpl } });
    const headerValue = (capturedHeaders as Record<string, string>)["X-Session-Id"] ?? (capturedHeaders as Record<string, string>)["x-session-id"];
    expect(headerValue).toBe("SESSION-123");
  });

  it("BroadcastError has status and detail fields", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "bad" }), { status: 500 })
    ) as typeof fetch;
    const thrown = await sendBroadcast({
      peers: ["x"], text: "y",
      deps: { localPort: 1, sessionId: "s", fetchImpl },
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(BroadcastError);
    expect(thrown).toBeInstanceOf(Error);
    expect(typeof thrown.status).toBe("number");
    expect(thrown.status).toBe(500);
    expect(thrown.detail).toBeDefined();
    expect(thrown.name).toBe("BroadcastError");
  });

  it("uses custom host when provided", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ context_id: "c", message_id: "m", results: [] }), { status: 200 });
    }) as typeof fetch;
    await sendBroadcast({
      peers: ["x"], text: "y",
      deps: { localPort: 4000, sessionId: "s", host: "10.0.0.1", fetchImpl },
    });
    expect(capturedUrl).toBe("http://10.0.0.1:4000/message:broadcast");
  });

  it("rethrows non-connection errors unchanged", async () => {
    const weirdError = new Error("something unexpected");
    const fetchImpl = (async () => { throw weirdError; }) as typeof fetch;
    await expect(sendBroadcast({
      peers: ["x"], text: "y",
      deps: { localPort: 1, sessionId: "s", fetchImpl },
    })).rejects.toBe(weirdError);
  });
});
