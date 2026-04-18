import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function listenOn(
  handler: express.RequestHandler,
): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());
  app.post("/message\\:send", handler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

async function setupDaemon(dir: string) {
  await runInit({ configDir: dir });
  fs.writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: {
        port: 0,
        host: "0.0.0.0",
        localPort: 0,
        rateLimit: "1000/hour",
        streamTimeoutSeconds: 300,
      },
      agents: {},
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );
}

describe("POST /message:broadcast", () => {
  const closers: Array<{ close: () => void }> = [];
  const sessions: TestSession[] = [];

  afterEach(async () => {
    for (const s of sessions) {
      s.controller.abort();
      await s.done;
    }
    sessions.length = 0;
    for (const c of closers) c.close();
    closers.length = 0;
  });

  it("rejects without X-Session-Id (403)", async () => {
    const dir = tmp("bc-no-session-");
    await setupDaemon(dir);
    const handle = await startServer({ configDir: dir });
    closers.push({ close: () => handle.close() });
    const port = (handle.localServer.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/message:broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peers: ["bob"], text: "hello" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects an invalid session id (403)", async () => {
    const dir = tmp("bc-bad-session-");
    await setupDaemon(dir);
    const handle = await startServer({ configDir: dir });
    closers.push({ close: () => handle.close() });
    const port = (handle.localServer.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ peers: ["bob"], text: "hello" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a body with no peers (400)", async () => {
    const dir = tmp("bc-no-peers-");
    await setupDaemon(dir);
    const handle = await startServer({ configDir: dir });
    closers.push({ close: () => handle.close() });
    const port = (handle.localServer.address() as { port: number }).port;

    // Register a sender session so auth passes
    const aliceSess = await registerTestSession(
      port,
      "alice",
      `http://127.0.0.1:19998`,
    );
    sessions.push(aliceSess);

    const res = await fetch(`http://127.0.0.1:${port}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": aliceSess.sessionId,
      },
      body: JSON.stringify({ peers: [], text: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_body");
  });

  it("200 with shared message_id for a single local peer", async () => {
    const dir = tmp("bc-single-local-");
    await setupDaemon(dir);

    // Spin up bob's local endpoint
    let bobReceived: unknown = null;
    const { server: bobServer, port: bobPort } = await listenOn((req, res) => {
      bobReceived = req.body;
      res.status(200).json({
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        artifacts: [{ artifactId: "r", parts: [{ kind: "text", text: "ok" }] }],
      });
    });
    closers.push(bobServer);

    const handle = await startServer({ configDir: dir });
    closers.push({ close: () => handle.close() });
    const port = (handle.localServer.address() as { port: number }).port;

    // Register sessions
    const aliceSess = await registerTestSession(
      port,
      "alice",
      `http://127.0.0.1:19993`,
    );
    sessions.push(aliceSess);
    const bobSess = await registerTestSession(
      port,
      "bob",
      `http://127.0.0.1:${bobPort}`,
    );
    sessions.push(bobSess);

    const res = await fetch(`http://127.0.0.1:${port}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": aliceSess.sessionId,
      },
      body: JSON.stringify({ peers: ["bob"], text: "hi bob from broadcast" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      context_id: string;
      message_id: string;
      results: Array<{ peer: string; delivery: string }>;
    };

    // Response shape
    expect(typeof body.context_id).toBe("string");
    expect(typeof body.message_id).toBe("string");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].peer).toBe("bob");
    expect(body.results[0].delivery).toBe("accepted");

    // Bob's endpoint received the message with correct shape
    const msg = (bobReceived as { message: Record<string, unknown> })?.message;
    expect(msg).toBeTruthy();
    expect(msg.messageId).toBe(body.message_id);
    expect(msg.contextId).toBe(body.context_id);
    expect((msg.parts as Array<{ text: string }>)[0].text).toBe("hi bob from broadcast");

    // Multi-party envelope extension is declared
    expect(msg.extensions).toContain("https://tidepool.dev/ext/multi-party-envelope/v1");

    // Participants list includes sender and recipient DIDs
    const metadata = msg.metadata as { participants: string[] };
    expect(metadata.participants).toContain("self::alice");
  });

  it("aggregates per-peer results for multiple local peers", async () => {
    const dir = tmp("bc-multi-local-");
    await setupDaemon(dir);

    let carolReceived: unknown = null;
    let daveReceived: unknown = null;

    const { server: carolServer, port: carolPort } = await listenOn((req, res) => {
      carolReceived = req.body;
      res.status(200).json({ id: "t", status: { state: "completed" }, artifacts: [] });
    });
    const { server: daveServer, port: davePort } = await listenOn((req, res) => {
      daveReceived = req.body;
      res.status(200).json({ id: "t", status: { state: "completed" }, artifacts: [] });
    });
    closers.push(carolServer, daveServer);

    const handle = await startServer({ configDir: dir });
    closers.push({ close: () => handle.close() });
    const port = (handle.localServer.address() as { port: number }).port;

    const aliceSess = await registerTestSession(port, "alice", `http://127.0.0.1:19992`);
    sessions.push(aliceSess);
    const carolSess = await registerTestSession(port, "carol", `http://127.0.0.1:${carolPort}`);
    sessions.push(carolSess);
    const daveSess = await registerTestSession(port, "dave", `http://127.0.0.1:${davePort}`);
    sessions.push(daveSess);

    const res = await fetch(`http://127.0.0.1:${port}/message:broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": aliceSess.sessionId,
      },
      body: JSON.stringify({
        peers: ["carol", "dave"],
        text: "group message",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      context_id: string;
      message_id: string;
      results: Array<{ peer: string; delivery: string }>;
    };

    // Both legs accepted
    expect(body.results).toHaveLength(2);
    const byPeer = Object.fromEntries(body.results.map((r) => [r.peer, r.delivery]));
    expect(byPeer["carol"]).toBe("accepted");
    expect(byPeer["dave"]).toBe("accepted");

    // Both received the SAME message_id and context_id
    const carolMsg = (carolReceived as { message: Record<string, unknown> })?.message;
    const daveMsg = (daveReceived as { message: Record<string, unknown> })?.message;
    expect(carolMsg.messageId).toBe(body.message_id);
    expect(daveMsg.messageId).toBe(body.message_id);
    expect(carolMsg.contextId).toBe(body.context_id);
    expect(daveMsg.contextId).toBe(body.context_id);

    // Participants list on each message includes all three agents
    const carolParticipants = (carolMsg.metadata as { participants: string[] }).participants;
    expect(carolParticipants).toContain("self::alice");
  });
});
