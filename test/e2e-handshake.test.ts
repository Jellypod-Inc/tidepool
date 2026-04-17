import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import { generateIdentity, getFingerprint } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { loadPeersConfig } from "../src/peers/config.js";
import type { RemoteAgent } from "../src/types.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

describe("e2e: connection handshake", () => {
  let tmpDir: string;
  let bobConfigDir: string;
  let bobServer: { close: () => void };
  let bobMockAgent: http.Server;
  let aliceCardServer: http.Server;
  let bobSession: TestSession;

  let aliceCert: Buffer;
  let aliceKey: Buffer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-handshake-"));

    // --- Alice's identity (no server, just a cert) ---
    const aliceConfigDir = path.join(tmpDir, "alice");

    await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "identity.crt"),
      keyPath: path.join(aliceConfigDir, "identity.key"),
    });

    aliceCert = fs.readFileSync(
      path.join(aliceConfigDir, "identity.crt"),
    );
    aliceKey = fs.readFileSync(
      path.join(aliceConfigDir, "identity.key"),
    );

    // --- Alice's mock agent card server (plain HTTP for fetchAgentCard) ---
    const aliceCardApp = express();
    aliceCardApp.get(
      "/alice-dev/.well-known/agent-card.json",
      (_req, res) => {
        res.json({
          name: "alice-dev",
          description: "Alice's dev agent",
          url: "https://alice.example.com:9900/alice-dev",
        });
      },
    );
    aliceCardServer = aliceCardApp.listen(48800, "127.0.0.1");

    // --- Bob's setup (accept mode) ---
    bobConfigDir = path.join(tmpDir, "bob");

    await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "identity.crt"),
      keyPath: path.join(bobConfigDir, "identity.key"),
    });

    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 39900,
          host: "0.0.0.0",
          localPort: 39901,
          rateLimit: "100/hour",
        },
        agents: {
          "rust-expert": {
            rateLimit: "50/hour",
            description: "Bob's Rust expert",
          },
        },
        connectionRequests: { mode: "accept" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Bob starts with no known peers — the handshake will write peers.toml
    const { writePeersConfig } = await import("../src/peers/config.js");
    writePeersConfig(path.join(bobConfigDir, "peers.toml"), { peers: {} });

    // Bob's mock agent
    const bobApp = express();
    bobApp.use(express.json());
    bobApp.post("/message\\:send", (_req, res) => {
      res.json({
        id: "task-bob",
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "response",
            parts: [{ kind: "text", text: "rust-expert says hello" }],
          },
        ],
      });
    });
    bobMockAgent = bobApp.listen(48801, "127.0.0.1");

    // Register alice as a remote agent so Bob can translate her X-Sender-Agent
    // back to a local handle when she posts after handshake. The handshake
    // establishes the friend entry; remoteAgents lists the (peer, agent) →
    // local handle mapping used for identity translation.
    const aliceFingerprint = getFingerprint(aliceCert.toString("utf8"));
    const aliceRemote: RemoteAgent = {
      localHandle: "alice-dev",
      remoteEndpoint: "https://alice.example.com:9900",
      remoteTenant: "alice-dev",
      certFingerprint: aliceFingerprint,
    };

    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [aliceRemote],
    });

    // Register bob's session so inbound messages can be delivered to his mock agent.
    bobSession = await registerTestSession(39901, "rust-expert", "http://127.0.0.1:48801");

    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    bobSession?.controller.abort();
    await bobSession?.done;
    bobMockAgent?.close();
    bobServer?.close();
    aliceCardServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rejects normal requests from unknown agents", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello!" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(403);
    const data = (await response.json()) as { status: { state: string } };
    expect(data.status.state).toBe("rejected");
  });

  it("accepts a CONNECTION_REQUEST from an unknown agent (accept mode)", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "conn-req-1",
            role: "user",
            parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
            extensions: ["https://tidepool.dev/ext/connection/v1"],
            metadata: {
              "https://tidepool.dev/ext/connection/v1": {
                type: "request",
                reason: "Want to learn Rust error handling",
                agent_card_url:
                  "http://127.0.0.1:48800/alice-dev/.well-known/agent-card.json",
              },
            },
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      messageId: string;
      role: string;
      parts: Array<{ kind: string; text: string }>;
      metadata: Record<string, Record<string, string>>;
    };
    expect(data.role).toBe("agent");
    expect(data.parts[0].text).toBe("Connection accepted");
    expect(
      data.metadata["https://tidepool.dev/ext/connection/v1"].type,
    ).toBe("accepted");
  });

  it("persisted the new peer to peers.toml", () => {
    const peersConfig = loadPeersConfig(
      path.join(bobConfigDir, "peers.toml"),
    );

    const peerHandles = Object.keys(peersConfig.peers);
    expect(peerHandles.length).toBeGreaterThanOrEqual(1);

    const aliceEntry = Object.entries(peersConfig.peers).find(
      ([handle]) => handle.startsWith("alice"),
    );
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry![1].fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("allows Alice to make normal requests after being friended", async () => {
    const response = await fetch(
      "https://127.0.0.1:39900/rust-expert/message:send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sender-Agent": "alice-dev",
        },
        body: JSON.stringify({
          message: {
            messageId: "test-post-friend",
            role: "user",
            parts: [{ kind: "text", text: "How do you handle errors?" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: aliceCert,
            key: aliceKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      status: { state: string };
      artifacts: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(data.status.state).toBe("completed");
    expect(data.artifacts[0].parts[0].text).toBe("rust-expert says hello");
  });
});
