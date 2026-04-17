/**
 * e2e-peers-inbound.test.ts
 *
 * Verifies that the inbound mTLS trust check accepts requests from a peer
 * whose cert fingerprint is listed in peers.toml.
 *
 * Scenario:
 *   Alice has Bob in peers.toml.
 *   Bob has Alice in peers.toml.
 *   Bob sends a message to Alice's agent via the public mTLS interface.
 *   Expected: Alice accepts the request and routes it to her mock agent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { writePeersConfig } from "../src/peers/config.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

function createMockAgent(
  name: string,
): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (_req, res) => {
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "completed" },
      artifacts: [
        {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} responded` }],
        },
      ],
    });
  });

  const server = http.createServer(app);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

describe("e2e: inbound trust via peers.toml", () => {
  let tmpDir: string;
  let aliceConfigDir: string;
  let bobConfigDir: string;
  let aliceMockServer: http.Server;
  let bobMockServer: http.Server;
  let aliceServer: Awaited<ReturnType<typeof startServer>>;
  let bobServer: Awaited<ReturnType<typeof startServer>>;
  let aliceSession: TestSession;
  let bobSession: TestSession;
  let aliceLocalPort: number;
  let bobLocalPort: number;
  let alicePublicPort: number;
  let bobPublicPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-inbound-"));
    aliceConfigDir = path.join(tmpDir, "alice");
    bobConfigDir = path.join(tmpDir, "bob");

    // --- Identities ---
    const aliceIdentity = await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "identity.crt"),
      keyPath: path.join(aliceConfigDir, "identity.key"),
    });

    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "identity.crt"),
      keyPath: path.join(bobConfigDir, "identity.key"),
    });

    // --- Mock agents ---
    const { server: aMock, port: aliceMockPort } =
      await createMockAgent("alice-dev");
    const { server: bMock, port: bobMockPort } =
      await createMockAgent("rust-expert");
    aliceMockServer = aMock;
    bobMockServer = bMock;

    // --- Probe ephemeral public ports ---
    const writePlaceholderConfig = (dir: string, agentName: string) => {
      fs.writeFileSync(
        path.join(dir, "server.toml"),
        TOML.stringify({
          server: { port: 0, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour", streamTimeoutSeconds: 10 },
          agents: { [agentName]: { rateLimit: "50/hour", description: `${agentName} agent` } },
          connectionRequests: { mode: "deny" },
          discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        } as any),
      );
      writePeersConfig(path.join(dir, "peers.toml"), { peers: {} });
    };

    writePlaceholderConfig(aliceConfigDir, "alice-dev");
    writePlaceholderConfig(bobConfigDir, "rust-expert");

    const aliceProbe = await startServer({ configDir: aliceConfigDir, remoteAgents: [] });
    alicePublicPort = (aliceProbe.publicServer.address() as any).port;
    aliceProbe.close();
    await new Promise((r) => setTimeout(r, 50));

    const bobProbe = await startServer({ configDir: bobConfigDir, remoteAgents: [] });
    bobPublicPort = (bobProbe.publicServer.address() as any).port;
    bobProbe.close();
    await new Promise((r) => setTimeout(r, 50));

    // --- Alice: peers.toml has Bob ---
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: alicePublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour", streamTimeoutSeconds: 10 },
        agents: { "alice-dev": { rateLimit: "50/hour", description: "Alice's dev agent" } },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // peers.toml: Bob's fingerprint lives here
    writePeersConfig(path.join(aliceConfigDir, "peers.toml"), {
      peers: {
        "bobs-rust": {
          fingerprint: bobIdentity.fingerprint,
          endpoint: `https://127.0.0.1:${bobPublicPort}`,
          agents: ["rust-expert"],
        },
      },
    });

    // --- Bob: peers.toml has Alice ---
    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: bobPublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour", streamTimeoutSeconds: 10 },
        agents: { "rust-expert": { rateLimit: "50/hour", description: "Bob's Rust expert" } },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    writePeersConfig(path.join(bobConfigDir, "peers.toml"), {
      peers: {
        "alices-dev": {
          fingerprint: aliceIdentity.fingerprint,
          endpoint: `https://127.0.0.1:${alicePublicPort}`,
          agents: ["alice-dev"],
        },
      },
    });

    // --- Start Tidepool servers ---
    // Alice configures Bob as a remoteAgent so the outbound direction (Alice→Bob)
    // works too, and so resolveLocalHandleForRemoteSender can map Bob's cert+tenant
    // to the local handle "bobs-rust" on inbound.
    aliceServer = await startServer({
      configDir: aliceConfigDir,
      remoteAgents: [
        {
          localHandle: "bobs-rust",
          remoteEndpoint: `https://127.0.0.1:${bobPublicPort}`,
          remoteTenant: "rust-expert",
          certFingerprint: bobIdentity.fingerprint,
        },
      ],
    });
    aliceLocalPort = (aliceServer.localServer.address() as any).port;

    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [
        {
          localHandle: "alices-dev",
          remoteEndpoint: `https://127.0.0.1:${alicePublicPort}`,
          remoteTenant: "alice-dev",
          certFingerprint: aliceIdentity.fingerprint,
        },
      ],
    });
    bobLocalPort = (bobServer.localServer.address() as any).port;

    aliceSession = await registerTestSession(
      aliceLocalPort,
      "alice-dev",
      `http://127.0.0.1:${aliceMockPort}`,
    );
    bobSession = await registerTestSession(
      bobLocalPort,
      "rust-expert",
      `http://127.0.0.1:${bobMockPort}`,
    );
  });

  afterAll(async () => {
    aliceSession?.controller.abort();
    bobSession?.controller.abort();
    await Promise.all([aliceSession?.done, bobSession?.done]);
    aliceMockServer?.close();
    bobMockServer?.close();
    aliceServer?.close();
    bobServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it(
    "accepts inbound request from a peer listed in peers.toml",
    async () => {
      // Bob sends to Alice's agent through both Tidepool daemons.
      // Bob's cert is in Alice's peers.toml only — this verifies the peers-first
      // trust path in server.ts.
      const response = await fetch(
        `http://127.0.0.1:${bobLocalPort}/alices-dev/message:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": bobSession.sessionId,
          },
          body: JSON.stringify({
            message: {
              messageId: "peers-inbound-1",
              role: "user",
              parts: [{ kind: "text", text: "Hello from Bob via peers.toml" }],
            },
          }),
        },
      );

      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.status?.state).toBe("completed");
      expect(data.artifacts?.[0]?.parts?.[0]?.text).toContain(
        "alice-dev responded",
      );
    },
    15_000,
  );

  it(
    "Alice can also send to Bob as before (smoke-check peer is bidirectional-capable)",
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${aliceLocalPort}/bobs-rust/message:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": aliceSession.sessionId,
          },
          body: JSON.stringify({
            message: {
              messageId: "peers-inbound-2",
              role: "user",
              parts: [{ kind: "text", text: "Hello from Alice" }],
            },
          }),
        },
      );

      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.status?.state).toBe("completed");
      expect(data.artifacts?.[0]?.parts?.[0]?.text).toContain(
        "rust-expert responded",
      );
    },
    15_000,
  );
});
