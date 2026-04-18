import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

import { randomUUID } from "node:crypto";

/**
 * Mock relay that stands in for the tidepool daemon.
 * - Implements POST /message:broadcast (the new single-call endpoint).
 * - Fans out to each peer's adapter HTTP port and returns a BroadcastResponse.
 * - Injects metadata.from = sender handle derived from X-Session-Id.
 */
function startMockRelay(adapters: Record<string, { httpPort: number }>) {
  // Session registry: sessionId → agent name
  const sessionToName: Record<string, string> = {};

  const app = express();
  app.use(express.json());
  // Stub session endpoint so start() can register without a real daemon.
  app.post("/.well-known/tidepool/agents/:name/session", (req, res) => {
    const name = req.params.name;
    const sessionId = `session-${name}-${Date.now()}`;
    sessionToName[sessionId] = name;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: session.registered\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    // Leave open to keep the SSE session alive
  });
  app.get("/.well-known/tidepool/peers", (_req, res) => {
    res.json(
      Object.keys(adapters).map((h) => ({ handle: h, did: null })),
    );
  });
  app.post("/message\\:broadcast", async (req, res) => {
    const sessionId = req.header("x-session-id") ?? "";
    const sender = sessionToName[sessionId];
    if (!sender) {
      res.status(403).json({ error: { code: "origin_denied", message: "Session not recognized" } });
      return;
    }

    const { peers, text, thread, addressed_to, in_reply_to } = req.body as {
      peers: string[];
      text: string;
      thread?: string;
      addressed_to?: string[];
      in_reply_to?: string;
    };

    const contextId = thread ?? randomUUID();
    const messageId = randomUUID();
    // Build participants list for multi-party sends (all senders + recipients)
    const participants = peers.length > 1 ? [sender, ...peers] : undefined;

    const results: Array<{ peer: string; delivery: "accepted" | "failed"; reason?: { kind: string; message: string } }> = [];

    for (const peer of peers) {
      const target = adapters[peer];
      if (!target) {
        results.push({
          peer,
          delivery: "failed",
          reason: { kind: "peer-not-registered", message: `No peer named "${peer}"` },
        });
        continue;
      }
      const message: Record<string, unknown> = {
        messageId,
        contextId,
        parts: [{ kind: "text", text }],
        metadata: {
          from: sender,
          ...(participants ? { participants } : {}),
          ...(addressed_to ? { addressed_to } : {}),
          ...(in_reply_to ? { in_reply_to } : {}),
        },
      };
      try {
        const upstream = await fetch(
          `http://127.0.0.1:${target.httpPort}/message:send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          },
        );
        if (upstream.ok) {
          results.push({ peer, delivery: "accepted" });
        } else {
          results.push({ peer, delivery: "failed", reason: { kind: "other", message: `HTTP ${upstream.status}` } });
        }
      } catch {
        results.push({ peer, delivery: "failed", reason: { kind: "peer-unreachable", message: "fetch failed" } });
      }
    }

    res.status(200).json({ context_id: contextId, message_id: messageId, results });
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      resolve({
        port,
        close: () => new Promise((r) => s.close(() => r())),
      });
    });
  });
}

function makeConfigDir(name: string, relayPort: number, httpPort: number) {
  const dir = mkdtempSync(path.join(tmpdir(), `adapter-${name}-`));
  writeFileSync(
    path.join(dir, "server.toml"),
    `
[server]
localPort = ${relayPort}

[agents.${name}]
localEndpoint = "http://127.0.0.1:${httpPort}"
`.trim(),
  );
  return dir;
}

describe("symmetric round-trip via mock relay", () => {
  let relay: { port: number; close: () => Promise<void> };
  let alice: { close: () => Promise<void>; port: number };
  let bob: { close: () => Promise<void>; port: number };
  let aliceClient: Client;
  let bobClient: Client;
  let aliceEvents: any[] = [];
  let bobEvents: any[] = [];

  beforeAll(async () => {
    // Pre-allocate adapter ports by binding+closing dummy servers
    const allocPort = () =>
      new Promise<number>((resolve) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as any).port;
          s.close(() => resolve(p));
        });
      });
    const alicePort = await allocPort();
    const bobPort = await allocPort();
    relay = await startMockRelay({
      alice: { httpPort: alicePort },
      bob: { httpPort: bobPort },
    });

    const aliceDir = makeConfigDir("alice", relay.port, alicePort);
    const bobDir = makeConfigDir("bob", relay.port, bobPort);

    const [aliceServerTransport, aliceClientTransport] =
      InMemoryTransport.createLinkedPair();
    const [bobServerTransport, bobClientTransport] =
      InMemoryTransport.createLinkedPair();

    const aliceStarted = await start({
      configDir: aliceDir,
      agentName: "alice",
      transport: aliceServerTransport,
    });
    const bobStarted = await start({
      configDir: bobDir,
      agentName: "bob",
      transport: bobServerTransport,
    });
    alice = { close: aliceStarted.close, port: alicePort };
    bob = { close: bobStarted.close, port: bobPort };

    aliceClient = new Client({ name: "test-alice", version: "0.0.1" }, {});
    bobClient = new Client({ name: "test-bob", version: "0.0.1" }, {});
    aliceClient.fallbackNotificationHandler = async (n) => {
      aliceEvents.push(n);
    };
    bobClient.fallbackNotificationHandler = async (n) => {
      bobEvents.push(n);
    };
    await aliceClient.connect(aliceClientTransport);
    await bobClient.connect(bobClientTransport);
  });

  afterAll(async () => {
    await aliceClient.close();
    await bobClient.close();
    await alice.close();
    await bob.close();
    await relay.close();
  });

  it("alice sends → bob receives event with peer=alice; bob continues thread; alice receives same context_id", async () => {
    aliceEvents = [];
    bobEvents = [];

    const sendResult = await aliceClient.callTool({
      name: "send",
      arguments: { peers: ["bob"], text: "hi bob" },
    });
    const sendData = JSON.parse((sendResult.content as any)[0].text);
    const ctx = sendData.context_id;
    expect(ctx).toBeTruthy();
    expect(typeof sendData.message_id).toBe("string");
    expect(sendData.results).toHaveLength(1);
    expect(sendData.results[0].peer).toBe("bob");
    expect(sendData.results[0].delivery).toBe("accepted");

    await vi.waitFor(() => expect(bobEvents).toHaveLength(1));
    expect(bobEvents[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hi bob",
        meta: { peer: "alice", context_id: ctx },
      },
    });
    // Pairwise message — no participants attr.
    expect(bobEvents[0].params.meta.participants).toBeUndefined();

    const replyResult = await bobClient.callTool({
      name: "send",
      arguments: { peers: ["alice"], text: "hey alice", thread: ctx },
    });
    const replyData = JSON.parse((replyResult.content as any)[0].text);
    expect(replyData.context_id).toBe(ctx);

    await vi.waitFor(() => expect(aliceEvents).toHaveLength(1));
    expect(aliceEvents[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hey alice",
        meta: { peer: "bob", context_id: ctx },
      },
    });
  });

  it("send returns isError result when peer is unknown (failed delivery)", async () => {
    const result = await aliceClient.callTool({
      name: "send",
      arguments: { peers: ["nonexistent"], text: "hi" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].delivery).toBe("failed");
    expect(data.results[0].reason.kind).toBe("peer-not-registered");
  });
});
