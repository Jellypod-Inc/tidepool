import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { start } from "../src/start.js";

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
  app.post("/:tenant/message\\:send", async (req, res) => {
    // Identify sender from session token
    const sessionId = req.header("x-session-id") ?? "";
    const sender = sessionToName[sessionId];
    if (!sender) {
      res.status(403).json({ error: { code: "origin_denied", message: "Session not recognized" } });
      return;
    }
    const tenant = req.params.tenant;
    const target = adapters[tenant];
    if (!target) {
      res.status(404).json({ error: { code: "peer_not_found", message: `No peer named "${tenant}"` } });
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

describe("three-agent multi-peer fan-out", () => {
  let relay: { port: number; close: () => Promise<void> };
  let wolverine: { close: () => Promise<void> };
  let alice: { close: () => Promise<void> };
  let bobby: { close: () => Promise<void> };
  let wolverineClient: Client;
  let aliceClient: Client;
  let bobbyClient: Client;
  let wolverineEvents: any[] = [];
  let aliceEvents: any[] = [];
  let bobbyEvents: any[] = [];

  beforeAll(async () => {
    const allocPort = () =>
      new Promise<number>((resolve) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as any).port;
          s.close(() => resolve(p));
        });
      });
    const wolverinePort = await allocPort();
    const alicePort = await allocPort();
    const bobbyPort = await allocPort();
    relay = await startMockRelay({
      wolverine: { httpPort: wolverinePort },
      alice: { httpPort: alicePort },
      bobby: { httpPort: bobbyPort },
    });

    const wolverineDir = makeConfigDir("wolverine", relay.port, wolverinePort);
    const aliceDir = makeConfigDir("alice", relay.port, alicePort);
    const bobbyDir = makeConfigDir("bobby", relay.port, bobbyPort);

    const [wsT, wcT] = InMemoryTransport.createLinkedPair();
    const [asT, acT] = InMemoryTransport.createLinkedPair();
    const [bsT, bcT] = InMemoryTransport.createLinkedPair();

    wolverine = await start({
      configDir: wolverineDir,
      agentName: "wolverine",
      transport: wsT,
    });
    alice = await start({
      configDir: aliceDir,
      agentName: "alice",
      transport: asT,
    });
    bobby = await start({
      configDir: bobbyDir,
      agentName: "bobby",
      transport: bsT,
    });

    wolverineClient = new Client({ name: "test-wolverine", version: "0.0.1" }, {});
    aliceClient = new Client({ name: "test-alice", version: "0.0.1" }, {});
    bobbyClient = new Client({ name: "test-bobby", version: "0.0.1" }, {});
    wolverineClient.fallbackNotificationHandler = async (n) => {
      wolverineEvents.push(n);
    };
    aliceClient.fallbackNotificationHandler = async (n) => {
      aliceEvents.push(n);
    };
    bobbyClient.fallbackNotificationHandler = async (n) => {
      bobbyEvents.push(n);
    };
    await wolverineClient.connect(wcT);
    await aliceClient.connect(acT);
    await bobbyClient.connect(bcT);
  });

  afterAll(async () => {
    await wolverineClient.close();
    await aliceClient.close();
    await bobbyClient.close();
    await wolverine.close();
    await alice.close();
    await bobby.close();
    await relay.close();
  });

  it("wolverine sends to [alice, bobby] with one context_id; both receive with participants; alice reply-alls", async () => {
    wolverineEvents = [];
    aliceEvents = [];
    bobbyEvents = [];

    const sendResult = await wolverineClient.callTool({
      name: "send",
      arguments: { peers: ["alice", "bobby"], text: "three-way kickoff" },
    });
    const sendData = JSON.parse((sendResult.content as any)[0].text);
    expect(sendData.results).toHaveLength(2);
    const ctx = sendData.context_id;

    await vi.waitFor(() => {
      expect(aliceEvents).toHaveLength(1);
      expect(bobbyEvents).toHaveLength(1);
    });

    for (const ev of [aliceEvents[0], bobbyEvents[0]]) {
      expect(ev).toMatchObject({
        method: "notifications/claude/channel",
        params: {
          content: "three-way kickoff",
          meta: {
            peer: "wolverine",
            context_id: ctx,
            participants: "wolverine alice bobby",
          },
        },
      });
    }

    // Alice reply-alls to the other participants on the same thread.
    await aliceClient.callTool({
      name: "send",
      arguments: {
        peers: ["wolverine", "bobby"],
        text: "alice replies to all",
        thread: ctx,
      },
    });

    await vi.waitFor(() => {
      expect(wolverineEvents).toHaveLength(1);
      expect(bobbyEvents).toHaveLength(2);
    });

    expect(wolverineEvents[0]).toMatchObject({
      params: {
        content: "alice replies to all",
        meta: {
          peer: "alice",
          context_id: ctx,
          participants: "alice wolverine bobby",
        },
      },
    });
    expect(bobbyEvents[1]).toMatchObject({
      params: {
        content: "alice replies to all",
        meta: {
          peer: "alice",
          context_id: ctx,
          participants: "alice wolverine bobby",
        },
      },
    });
  });
});
