import { describe, expect, it, vi } from "vitest";
import { sendOutbound } from "../src/outbound.js";
import type { InboundInfo } from "../src/http.js";

function makeFetch(response: {
  ok?: boolean;
  status?: number;
  body: unknown;
}) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.body,
  })) as unknown as typeof fetch;
}

async function waitFor<T>(
  get: () => T | undefined,
  timeoutMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for onReply");
}

describe("sendOutbound", () => {
  it("POSTs to the local proxy and emits the peer's reply as a channel notification", async () => {
    const fetchImpl = makeFetch({
      body: {
        id: "ignored",
        contextId: "c1",
        status: { state: "completed" },
        artifacts: [{ parts: [{ kind: "text", text: "hi from bob" }] }],
      },
    });
    let emitted: InboundInfo | undefined;

    const { taskId } = await sendOutbound({
      peer: "bob",
      text: "hello",
      deps: {
        localPort: 9901,
        fetchImpl,
        onReply: (info) => {
          emitted = info;
        },
      },
    });

    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    const call = (fetchImpl as any).mock.calls[0];
    expect(call[0]).toBe("http://127.0.0.1:9901/bob/message:send");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    expect(body.message.parts[0].text).toBe("hello");
    expect(body.message.messageId).toBe(taskId);

    const reply = await waitFor(() => emitted);
    expect(reply.taskId).toBe(taskId);
    expect(reply.text).toBe("hi from bob");
  });

  it("percent-encodes peer handles with unusual characters", async () => {
    const fetchImpl = makeFetch({
      body: { status: { state: "completed" }, artifacts: [] },
    });
    let emitted: InboundInfo | undefined;
    await sendOutbound({
      peer: "weird name/with slash",
      text: "x",
      deps: {
        localPort: 1,
        fetchImpl,
        onReply: (i) => {
          emitted = i;
        },
      },
    });
    const url = (fetchImpl as any).mock.calls[0][0] as string;
    expect(url).toContain("/weird%20name%2Fwith%20slash/message:send");
    await waitFor(() => emitted);
  });

  it("on 404 from the daemon, surfaces a hint pointing at list_peers", async () => {
    const fetchImpl = makeFetch({
      ok: false,
      status: 404,
      body: { error: "Agent not found" },
    });
    let emitted: InboundInfo | undefined;

    await sendOutbound({
      peer: "ghost",
      text: "hi",
      deps: {
        localPort: 9901,
        fetchImpl,
        onReply: (info) => {
          emitted = info;
        },
      },
    });

    const reply = await waitFor(() => emitted);
    expect(reply.text).toContain("no agent named \"ghost\"");
    expect(reply.text).toContain("claw_connect_list_peers");
    expect(reply.text).toContain("How to recover:");
  });

  it("on 504/failed, surfaces a hint about the peer's adapter being down", async () => {
    const fetchImpl = makeFetch({
      ok: false,
      status: 504,
      body: { status: { state: "failed", message: "timeout" } },
    });
    let emitted: InboundInfo | undefined;

    await sendOutbound({
      peer: "bobby",
      text: "hi",
      deps: {
        localPort: 9901,
        fetchImpl,
        onReply: (info) => {
          emitted = info;
        },
      },
    });

    const reply = await waitFor(() => emitted);
    expect(reply.text).toContain("didn't respond");
    expect(reply.text).toContain("claude-code:start");
  });

  it("on ECONNREFUSED, surfaces a hint telling the user to start the daemon", async () => {
    const fetchImpl = vi.fn(async () => {
      const err: Error & { cause?: { code?: string } } = new Error(
        "fetch failed",
      );
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    let emitted: InboundInfo | undefined;

    await sendOutbound({
      peer: "bob",
      text: "hi",
      deps: {
        localPort: 9901,
        fetchImpl,
        onReply: (info) => {
          emitted = info;
        },
      },
    });

    const reply = await waitFor(() => emitted);
    expect(reply.text).toContain("daemon isn't running");
    expect(reply.text).toContain("claw-connect claude-code:start");
    expect(reply.text).toContain("claw-connect serve");
  });

  it("on a generic network error, surfaces a hint pointing at status + logs", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("something weird");
    }) as unknown as typeof fetch;
    let emitted: InboundInfo | undefined;

    await sendOutbound({
      peer: "bob",
      text: "hi",
      deps: {
        localPort: 9901,
        fetchImpl,
        onReply: (info) => {
          emitted = info;
        },
      },
    });

    const reply = await waitFor(() => emitted);
    expect(reply.text).toContain("something weird");
    expect(reply.text).toContain("claw-connect status");
  });
});
