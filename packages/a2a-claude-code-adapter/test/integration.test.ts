import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.any().optional(),
  }),
});

let tmp: string;
let handle: Awaited<ReturnType<typeof start>> | null = null;

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-int-"));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("integration", () => {
  it("routes an A2A POST → channel notification → reply tool → A2A response", async () => {
    const port = await pickPort();
    const localPort = await pickPort();
    fs.writeFileSync(
      path.join(tmp, "server.toml"),
      `[server]
localPort = ${localPort}

[agents.bob]
localEndpoint = "http://127.0.0.1:${port}"
`,
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    handle = await start({
      configDir: tmp,
      host: "127.0.0.1",
      replyTimeoutMs: 2_000,
      transport: serverTransport,
    });

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    // Listen for the channel notification.
    const notifications: any[] = [];
    client.setNotificationHandler(ChannelNotificationSchema, async (n) => {
      notifications.push(n);
    });

    // POST as if we were claw-connect.
    const fetchPromise = fetch(`http://127.0.0.1:${port}/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "is Rust memory-safe?" }],
        },
      }),
    });

    // Wait for the notification to arrive at our client.
    const deadline = Date.now() + 1_000;
    while (notifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("notifications/claude/channel");
    const taskId = notifications[0].params.meta.task_id;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notifications[0].params.content).toBe("is Rust memory-safe?");

    // Claude calls the reply tool.
    const toolResult = await client.callTool({
      name: "claw_connect_reply",
      arguments: { task_id: taskId, text: "Yes, by construction." },
    });
    expect((toolResult.content as any)[0].text).toContain("sent");

    // The original HTTP request resolves with the reply.
    const res = await fetchPromise;
    const body = (await res.json()) as any;
    expect(body.status.state).toBe("completed");
    expect(body.artifacts[0].parts[0].text).toBe("Yes, by construction.");
    expect(body.id).toBe(taskId);

    await client.close();
  });
});
