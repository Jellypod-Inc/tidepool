/**
 * e2e-multi-party-envelope.test.ts
 *
 * End-to-end tests for the multi-party envelope protocol (Tasks 13–15).
 *
 * Topology: single daemon, three local agents (alice, bob, carol).
 * All agents have inbox HTTP servers that capture inbound messages.
 *
 * P0 — self/addressed_to/message_id correctness
 * P1 — in_reply_to threading
 * P2 — delivery acks (accepted / failed)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { runInit } from "../src/cli/init.js";
import { startServer } from "../src/server.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Inbox helper — captures inbound message:send bodies
// ---------------------------------------------------------------------------

interface CapturedMessage {
  messageId: string;
  contextId: string;
  metadata: Record<string, unknown>;
  text: string;
  raw: Record<string, unknown>;
}

interface Inbox {
  messages: CapturedMessage[];
  close: () => Promise<void>;
}

async function startInbox(name: string): Promise<{ port: number; inbox: Inbox }> {
  const messages: CapturedMessage[] = [];
  const app = express();
  app.use(express.json());
  app.post("/message\\:send", (req, res) => {
    const msg = req.body?.message as Record<string, unknown> | undefined;
    if (msg) {
      messages.push({
        messageId: msg.messageId as string,
        contextId: msg.contextId as string,
        metadata: (msg.metadata as Record<string, unknown>) ?? {},
        text: (msg.parts as Array<{ text: string }>)?.[0]?.text ?? "",
        raw: msg,
      });
    }
    res.json({
      id: `task-${name}`,
      contextId: msg?.contextId,
      status: { state: "completed" },
      artifacts: [],
    });
  });
  const server = http.createServer(app);
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
  return {
    port,
    inbox: {
      messages,
      close: () => new Promise((r) => server.close(() => r())),
    },
  };
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function waitFor<T>(
  fn: () => T,
  check: (v: T) => boolean,
  timeoutMs = 1500,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (check(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timeout");
}

// ---------------------------------------------------------------------------
// Fixture state shared across all tests in a describe block
// ---------------------------------------------------------------------------

interface Fixture {
  daemonLocalPort: number;
  daemon: Awaited<ReturnType<typeof startServer>>;
  alice: { session: TestSession; inbox: Inbox };
  bob: { session: TestSession; inbox: Inbox };
  carol: { session: TestSession; inbox: Inbox };
  tmpDir: string;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-mpe-"));

  await runInit({ configDir: tmpDir });
  fs.writeFileSync(
    path.join(tmpDir, "server.toml"),
    TOML.stringify({
      server: {
        port: 0,
        host: "0.0.0.0",
        localPort: 0,
        rateLimit: "1000/hour",
        streamTimeoutSeconds: 300,
      },
      agents: {
        alice: { rateLimit: "500/hour", description: "alice agent" },
        bob: { rateLimit: "500/hour", description: "bob agent" },
        carol: { rateLimit: "500/hour", description: "carol agent" },
      },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );

  const daemon = await startServer({ configDir: tmpDir });
  const daemonLocalPort = (daemon.localServer.address() as { port: number }).port;

  const { port: alicePort, inbox: aliceInbox } = await startInbox("alice");
  const { port: bobPort, inbox: bobInbox } = await startInbox("bob");
  const { port: carolPort, inbox: carolInbox } = await startInbox("carol");

  const aliceSession = await registerTestSession(daemonLocalPort, "alice", `http://127.0.0.1:${alicePort}`);
  const bobSession = await registerTestSession(daemonLocalPort, "bob", `http://127.0.0.1:${bobPort}`);
  const carolSession = await registerTestSession(daemonLocalPort, "carol", `http://127.0.0.1:${carolPort}`);

  return {
    daemonLocalPort,
    daemon,
    alice: { session: aliceSession, inbox: aliceInbox },
    bob: { session: bobSession, inbox: bobInbox },
    carol: { session: carolSession, inbox: carolInbox },
    tmpDir,
  };
}

async function teardownFixture(fix: Fixture) {
  fix.alice.session.controller.abort();
  fix.bob.session.controller.abort();
  fix.carol.session.controller.abort();
  await Promise.all([
    fix.alice.session.done,
    fix.bob.session.done,
    fix.carol.session.done,
  ]);
  await fix.alice.inbox.close();
  await fix.bob.inbox.close();
  await fix.carol.inbox.close();
  fix.daemon.close();
  fs.rmSync(fix.tmpDir, { recursive: true, force: true });
}

type BroadcastResult = {
  context_id: string;
  message_id: string;
  results: Array<{ peer: string; delivery: string; reason?: unknown }>;
};

async function broadcast(
  fix: Fixture,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${fix.daemonLocalPort}/message:broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// P0: self + addressed_to + message_id correctness
// ---------------------------------------------------------------------------

describe("P0: self, addressed_to, and message_id envelope invariants", () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fix);
  });

  it("P0-1: each receiver sees their own handle as metadata.self", async () => {
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob", "carol"],
      text: "hello group",
    });

    expect(status).toBe(200);

    // Wait for async delivery to both inboxes
    await waitFor(() => fix.bob.inbox.messages.length, (n) => n >= 1);
    await waitFor(() => fix.carol.inbox.messages.length, (n) => n >= 1);

    expect(fix.bob.inbox.messages[0].metadata.self).toBe("bob");
    expect(fix.carol.inbox.messages[0].metadata.self).toBe("carol");

    void body; // suppress unused warning
  }, 10_000);

  it("P0-2: addressed_to is preserved per-recipient as a handle list", async () => {
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob", "carol"],
      text: "direct but forwarded",
      addressed_to: ["bob"],
    });

    expect(status).toBe(200);

    await waitFor(() => fix.bob.inbox.messages.length, (n) => n >= 1);
    await waitFor(() => fix.carol.inbox.messages.length, (n) => n >= 1);

    // Both bob and carol receive the message; both see addressed_to containing "bob"
    const bobAddressedTo = fix.bob.inbox.messages[0].metadata.addressed_to as string[] | undefined;
    const carolAddressedTo = fix.carol.inbox.messages[0].metadata.addressed_to as string[] | undefined;

    expect(bobAddressedTo).toBeDefined();
    expect(carolAddressedTo).toBeDefined();
    expect(bobAddressedTo).toContain("bob");
    expect(carolAddressedTo).toContain("bob");

    void body;
  }, 10_000);

  it("P0-3: shared message_id across all fanout legs", async () => {
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob", "carol"],
      text: "shared id check",
    });

    expect(status).toBe(200);
    const broadcastBody = body as BroadcastResult;
    const messageId = broadcastBody.message_id;
    expect(typeof messageId).toBe("string");

    await waitFor(() => fix.bob.inbox.messages.length, (n) => n >= 1);
    await waitFor(() => fix.carol.inbox.messages.length, (n) => n >= 1);

    expect(fix.bob.inbox.messages[0].messageId).toBe(messageId);
    expect(fix.carol.inbox.messages[0].messageId).toBe(messageId);
    expect(fix.bob.inbox.messages[0].contextId).toBe(broadcastBody.context_id);
    expect(fix.carol.inbox.messages[0].contextId).toBe(broadcastBody.context_id);
  }, 10_000);

  it("P0-4: addressed_to containing a non-peer handle is rejected (invalid_addressed_to)", async () => {
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob"],
      text: "addressed to ghost",
      addressed_to: ["ghost"],
    });

    expect(status).toBe(400);
    expect(["invalid_addressed_to", "unknown_peer"]).toContain(
      (body as { code: string }).code,
    );

    // Bob should NOT have received anything
    await new Promise((r) => setTimeout(r, 80));
    expect(fix.bob.inbox.messages).toHaveLength(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// P1: in_reply_to threading
// ---------------------------------------------------------------------------

describe("P1: in_reply_to threading invariants", () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fix);
  });

  it("P1-5: parallel replies to same message both succeed with matching in_reply_to", async () => {
    // Alice establishes the original message
    const { status: s1, body: b1 } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob", "carol"],
      text: "original message",
    });
    expect(s1).toBe(200);

    const orig = b1 as BroadcastResult;
    const origMessageId = orig.message_id;
    const contextId = orig.context_id;

    // Wait for alice's message to arrive at both bob and carol
    await waitFor(() => fix.bob.inbox.messages.length, (n) => n >= 1);
    await waitFor(() => fix.carol.inbox.messages.length, (n) => n >= 1);

    // The thread index records alice's message_id from inbound delivery;
    // bob and carol reply with in_reply_to=origMessageId in alice's thread
    const [bobReply, carolReply] = await Promise.all([
      broadcast(fix, fix.bob.session.sessionId, {
        peers: ["alice", "carol"],
        text: "bob replies",
        thread: contextId,
        in_reply_to: origMessageId,
      }),
      broadcast(fix, fix.carol.session.sessionId, {
        peers: ["alice", "bob"],
        text: "carol replies",
        thread: contextId,
        in_reply_to: origMessageId,
      }),
    ]);

    expect(bobReply.status).toBe(200);
    expect(carolReply.status).toBe(200);

    const bobResult = bobReply.body as BroadcastResult;
    const carolResult = carolReply.body as BroadcastResult;

    // Both replies reference the same original message_id (not each other)
    expect(bobResult.context_id).toBe(contextId);
    expect(carolResult.context_id).toBe(contextId);

    // Wait for cross-deliveries
    await waitFor(() => fix.alice.inbox.messages.length, (n) => n >= 2);

    // alice received bob's and carol's replies
    const aliceMessages = fix.alice.inbox.messages;
    const inReplyTos = aliceMessages.map((m) => m.metadata.in_reply_to);
    for (const irt of inReplyTos) {
      expect(irt).toBe(origMessageId);
    }
  }, 15_000);

  it("P1-6: in_reply_to referencing an absent id in a known thread is rejected", async () => {
    // Step 1: establish a known thread
    const { status: s1, body: b1 } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob"],
      text: "first message",
    });
    expect(s1).toBe(200);
    const { context_id: contextId } = b1 as BroadcastResult;

    // Step 2: reply in same thread with a bogus in_reply_to id
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob"],
      text: "reply with bogus ref",
      thread: contextId,
      in_reply_to: "00000000-0000-4000-8000-000000000999",
    });

    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe("invalid_in_reply_to");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// P2: delivery acks
// ---------------------------------------------------------------------------

describe("P2: delivery acknowledgement", () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await teardownFixture(fix);
  });

  it("P2-7: delivery=accepted for an online silent peer (no reply)", async () => {
    // Bob is online (session registered, inbox running) but won't send back
    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob"],
      text: "will bob ack?",
    });

    expect(status).toBe(200);
    const result = body as BroadcastResult;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].peer).toBe("bob");
    expect(result.results[0].delivery).toBe("accepted");
  }, 10_000);

  it("P2-8: delivery=failed for a peer whose session has been torn down", async () => {
    // Tear down carol's session before the send
    fix.carol.session.controller.abort();
    await fix.carol.session.done;
    // Give the SSE disconnect a moment to propagate to the registry
    await new Promise((r) => setTimeout(r, 100));

    const { status, body } = await broadcast(fix, fix.alice.session.sessionId, {
      peers: ["bob", "carol"],
      text: "mixed online/offline",
    });

    expect(status).toBe(200);
    const result = body as BroadcastResult;
    const byPeer = Object.fromEntries(result.results.map((r) => [r.peer, r.delivery]));

    expect(byPeer["bob"]).toBe("accepted");
    expect(byPeer["carol"]).toBe("failed");
  }, 10_000);
});
