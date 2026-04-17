import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

/**
 * Mock relay that stands in for tidepool.
 * - Listens on a random port.
 * - Validates X-Agent header.
 * - Forwards POST /:tenant/message:send to the tenant's adapter HTTP port,
 *   injecting metadata.from = X-Agent value.
 */
function startMockRelay(adapters: Record<string, { httpPort: number }>) {
  const app = express();
  app.use(express.json());
  app.post("/:tenant/message\\:send", async (req, res) => {
    const sender = req.header("x-agent");
    if (!sender || !adapters[sender]) {
      res.status(403).json({ error: "X-Agent invalid" });
      return;
    }
    const tenant = req.params.tenant;
    const target = adapters[tenant];
    if (!target) {
      res.status(404).json({ error: "tenant not found" });
      return;
    }
    const body = {
      ...req.body,
      message: {
        ...req.body.message,
        metadata: { ...(req.body.message?.metadata ?? {}), from: sender },
      },
    };
    const upstream = await fetch(
      `http://127.0.0.1:${target.httpPort}/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await upstream.json();
    res.status(upstream.status).json(json);
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
  writeFileSync(path.join(dir, "remotes.toml"), "[remotes]\n");
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
    expect(sendData.results).toHaveLength(1);
    expect(sendData.results[0].peer).toBe("bob");
    expect(typeof sendData.results[0].message_id).toBe("string");

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

  it("send returns isError result when relay returns 404 (unknown tenant)", async () => {
    const result = await aliceClient.callTool({
      name: "send",
      arguments: { peers: ["nonexistent"], text: "hi" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].error.kind).toBe("peer-not-registered");
  });
});
