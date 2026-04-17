import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { loadFriendsConfig } from "../src/config.js";
import { createDirectoryApp } from "../src/directory-server.js";
import { DirectoryProvider } from "../src/discovery/directory-provider.js";
import type { RemoteAgent } from "../src/types.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

/**
 * End-to-end: discovery → connect.
 *
 * Three actors:
 *  - Directory: in-process registry (src/directory-server.ts) on plain HTTP.
 *  - Bob: Tidepool server with connectionRequests.mode="accept", advertises
 *    himself to the directory on boot.
 *  - Alice: cert/key only (no server), queries the directory, then sends a
 *    CONNECTION_REQUEST to the discovered endpoint over mTLS.
 *
 * Verifies the full cycle: directory lookup returns an online agent → Alice
 * connects and is accepted → Alice is persisted to friends.toml → Alice can
 * then send a normal A2A message and get a response.
 */
describe("e2e: discovery → connect → A2A", () => {
  let tmpDir: string;
  let bobConfigDir: string;
  let bobServer: { close: () => void };
  let bobMockAgent: http.Server;
  let aliceCardServer: http.Server;
  let directoryServer: http.Server;

  let aliceCert: Buffer;
  let aliceKey: Buffer;
  let aliceFingerprint: string;
  let bobFingerprint: string;
  let bobSession: TestSession;

  // Ports — chosen to avoid collision with other e2e test files.
  const DIRECTORY_PORT = 58900;
  const BOB_PUBLIC = 58910;
  const BOB_LOCAL = 58911;
  const BOB_MOCK = 58920;
  const ALICE_CARD = 58930;

  const DIRECTORY_URL = `http://127.0.0.1:${DIRECTORY_PORT}`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-discovery-e2e-"));

    // --- Directory server (plain HTTP, in-process) ---
    const { app: directoryApp } = createDirectoryApp();
    directoryServer = directoryApp.listen(DIRECTORY_PORT, "127.0.0.1");

    // --- Alice's identity (cert only, no server) ---
    const aliceConfigDir = path.join(tmpDir, "alice");
    const aliceIdentity = await generateIdentity({
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
    aliceFingerprint = aliceIdentity.fingerprint;

    // Alice's Agent Card server — Bob fetches this during handshake to learn
    // who she says she is.
    const aliceCardApp = express();
    aliceCardApp.get(
      "/alice-dev/.well-known/agent-card.json",
      (_req, res) => {
        res.json({
          name: "alice-dev",
          description: "Alice's dev agent",
          url: `https://alice.example.com/alice-dev`,
        });
      },
    );
    aliceCardServer = aliceCardApp.listen(ALICE_CARD, "127.0.0.1");

    // --- Bob's setup ---
    bobConfigDir = path.join(tmpDir, "bob");
    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "identity.crt"),
      keyPath: path.join(bobConfigDir, "identity.key"),
    });
    bobFingerprint = bobIdentity.fingerprint;

    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: BOB_PUBLIC,
          host: "0.0.0.0",
          localPort: BOB_LOCAL,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          "rust-expert": {
            rateLimit: "50/hour",
            description: "Bob's Rust expert",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "accept" },
        discovery: {
          providers: ["directory"],
          cacheTtlSeconds: 300,
          directory: { enabled: true, url: DIRECTORY_URL },
        },
      } as any),
    );

    fs.writeFileSync(
      path.join(bobConfigDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

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
            parts: [{ kind: "text", text: "rust-expert via discovery" }],
          },
        ],
      });
    });
    bobMockAgent = bobApp.listen(BOB_MOCK, "127.0.0.1");

    // Register alice as a remote so Bob's inbound mTLS handler can translate
    // alice's X-Sender-Agent back to a local handle after handshake.
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

    // Register bob's session so inbound messages can be routed to his mock agent.
    bobSession = await registerTestSession(BOB_LOCAL, "rust-expert", `http://127.0.0.1:${BOB_MOCK}`);

    // Bob advertises himself to the directory on boot. In production this
    // would be triggered by the server wiring; here we drive it explicitly
    // to keep the test focused on the discovery→connect flow.
    const bobDirectory = new DirectoryProvider(DIRECTORY_URL, bobFingerprint);
    await bobDirectory.advertise({
      handle: "rust-expert",
      description: "Bob's Rust expert",
      endpoint: `https://127.0.0.1:${BOB_PUBLIC}`,
      agentCardUrl: `https://127.0.0.1:${BOB_PUBLIC}/rust-expert/.well-known/agent-card.json`,
      status: "online",
    });

    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    bobSession?.controller.abort();
    await bobSession?.done;
    bobMockAgent?.close();
    bobServer?.close();
    aliceCardServer?.close();
    directoryServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("Alice discovers Bob via directory with status online", async () => {
    // Alice queries the directory using her fingerprint for advertise-auth
    // headers (not used by search/resolve but required by the constructor).
    const aliceDirectory = new DirectoryProvider(DIRECTORY_URL, aliceFingerprint);
    const results = await aliceDirectory.search({ query: "rust" });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const rust = results.find((a) => a.handle === "rust-expert");
    expect(rust).toBeDefined();
    expect(rust!.status).toBe("online");
    expect(rust!.endpoint).toBe(`https://127.0.0.1:${BOB_PUBLIC}`);
  });

  it("Alice sends CONNECTION_REQUEST to the discovered endpoint and is accepted", async () => {
    const aliceDirectory = new DirectoryProvider(DIRECTORY_URL, aliceFingerprint);
    const discovered = await aliceDirectory.resolve("rust-expert");
    expect(discovered).not.toBeNull();

    const response = await fetch(
      `${discovered!.endpoint}/rust-expert/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "discovery-conn-req",
            role: "user",
            parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
            extensions: ["https://tidepool.dev/ext/connection/v1"],
            metadata: {
              "https://tidepool.dev/ext/connection/v1": {
                type: "request",
                reason: "Found you in the directory",
                agent_card_url: `http://127.0.0.1:${ALICE_CARD}/alice-dev/.well-known/agent-card.json`,
              },
            },
          },
        }),
        // @ts-expect-error — undici dispatcher for client mTLS
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
    expect(data.metadata["https://tidepool.dev/ext/connection/v1"].type).toBe("accepted");
  });

  it("Bob's friends.toml now contains Alice's fingerprint", () => {
    const friendsConfig = loadFriendsConfig(
      path.join(bobConfigDir, "friends.toml"),
    );

    const aliceEntry = Object.entries(friendsConfig.friends).find(
      ([, friend]) => friend.fingerprint === aliceFingerprint,
    );
    expect(aliceEntry).toBeDefined();
  });

  it("Alice can send a normal A2A message now that she is friended", async () => {
    const response = await fetch(
      `https://127.0.0.1:${BOB_PUBLIC}/rust-expert/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sender-Agent": "alice-dev",
        },
        body: JSON.stringify({
          message: {
            messageId: "discovery-post-friend",
            role: "user",
            parts: [{ kind: "text", text: "Hi Bob" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for client mTLS
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
    expect(data.artifacts[0].parts[0].text).toBe("rust-expert via discovery");
  });
});
