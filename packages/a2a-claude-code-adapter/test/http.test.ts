import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingRegistry } from "../src/pending.js";
import { startHttp } from "../src/http.js";

let server: Awaited<ReturnType<typeof startHttp>> | null = null;
let registry: PendingRegistry;

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
  });
}

beforeEach(() => {
  registry = new PendingRegistry();
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe("startHttp", () => {
  it("notifies onInbound and returns the A2A response after resolve", async () => {
    const port = await pickPort();
    const inbound: Array<{ taskId: string; text: string }> = [];
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 1_000,
      onInbound: (info) => {
        inbound.push({ taskId: info.taskId, text: info.text });
        setImmediate(() => registry.resolve(info.taskId, "pong"));
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "ping" }],
        },
      }),
    });
    const body = (await res.json()) as any;

    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe("ping");
    expect(body.status.state).toBe("completed");
    expect(body.artifacts[0].parts[0].text).toBe("pong");
    expect(body.id).toBe(inbound[0].taskId);
  });

  it("responds 504 when the pending task times out", async () => {
    const port = await pickPort();
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 10,
      onInbound: () => {
        // never resolve
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "ping" }],
        },
      }),
    });

    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.status.state).toBe("failed");
  });

  it("returns 400 when the body is missing message.parts", async () => {
    const port = await pickPort();
    server = await startHttp({
      port,
      host: "127.0.0.1",
      registry,
      replyTimeoutMs: 1_000,
      onInbound: () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(400);
  });
});
