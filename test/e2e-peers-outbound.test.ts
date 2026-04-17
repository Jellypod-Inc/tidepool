/**
 * e2e-peers-outbound.test.ts
 *
 * Verifies that the new /:peer/:agent/:action route routes outbound A2A
 * messages via peers.toml — without needing a remotes.toml entry.
 *
 * Scenario:
 *   Alice has Bob in peers.toml (no remotes.toml entry for Bob).
 *   Bob has Alice in friends.toml + a remoteAgents entry so the inbound
 *   X-Sender-Agent lookup works.
 *   Alice's adapter POSTs to /bobs-peer/writer/message:send on Alice's
 *   local interface.
 *   Expected: Alice proxies the request over mTLS to Bob's public interface,
 *   Bob routes it to his mock agent, and Alice's caller gets a completed
 *   artifact back.
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

describe("e2e: outbound routing via peers.toml (scoped /peer/agent/:action route)", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-outbound-"));
    aliceConfigDir = path.join(tmpDir, "alice");
    bobConfigDir = path.join(tmpDir, "bob");

    // --- Identities ---
    const aliceIdentity = await generateIdentity({
      name: "alice-sender",
      certPath: path.join(aliceConfigDir, "identity.crt"),
      keyPath: path.join(aliceConfigDir, "identity.key"),
    });

    const bobIdentity = await generateIdentity({
      name: "bob-writer",
      certPath: path.join(bobConfigDir, "identity.crt"),
      keyPath: path.join(bobConfigDir, "identity.key"),
    });

    // --- Mock agents ---
    const { server: aMock, port: aliceMockPort } =
      await createMockAgent("alice-sender");
    const { server: bMock, port: bobMockPort } =
      await createMockAgent("writer");
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
      fs.writeFileSync(
        path.join(dir, "friends.toml"),
        TOML.stringify({ friends: {} } as any),
      );
    };

    writePlaceholderConfig(aliceConfigDir, "alice-sender");
    writePlaceholderConfig(bobConfigDir, "writer");

    const aliceProbe = await startServer({ configDir: aliceConfigDir, remoteAgents: [] });
    alicePublicPort = (aliceProbe.publicServer.address() as any).port;
    aliceProbe.close();
    await new Promise((r) => setTimeout(r, 50));

    const bobProbe = await startServer({ configDir: bobConfigDir, remoteAgents: [] });
    bobPublicPort = (bobProbe.publicServer.address() as any).port;
    bobProbe.close();
    await new Promise((r) => setTimeout(r, 50));

    // --- Alice: peers.toml has Bob; NO remotes.toml entry for Bob ---
    // This tests the new /:peer/:agent/:action route uses peers.toml only.
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: alicePublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour", streamTimeoutSeconds: 10 },
        agents: { "alice-sender": { rateLimit: "50/hour", description: "Alice's sender agent" } },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(aliceConfigDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    // peers.toml: Bob's fingerprint + endpoint + advertised agents
    writePeersConfig(path.join(aliceConfigDir, "peers.toml"), {
      peers: {
        "bobs-peer": {
          fingerprint: bobIdentity.fingerprint,
          endpoint: `https://127.0.0.1:${bobPublicPort}`,
          agents: ["writer"],
        },
      },
    });

    // --- Bob: friends.toml has Alice; peers.toml empty ---
    // Bob also needs a remoteAgents entry for Alice so the inbound
    // X-Sender-Agent → local handle lookup works.
    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: bobPublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour", streamTimeoutSeconds: 10 },
        agents: { "writer": { rateLimit: "50/hour", description: "Bob's writer agent" } },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(bobConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "alices-peer": { fingerprint: aliceIdentity.fingerprint },
        },
      } as any),
    );

    // --- Start Tidepool servers ---
    // Alice passes NO remoteAgents for Bob — the new /:peer/:agent/:action
    // route should resolve Bob entirely from peers.toml.
    aliceServer = await startServer({
      configDir: aliceConfigDir,
      remoteAgents: [],
    });
    aliceLocalPort = (aliceServer.localServer.address() as any).port;

    // Bob needs a remoteAgents entry for Alice so the inbound
    // resolveLocalHandleForRemoteSender lookup can map Alice's cert+tenant
    // to the local handle "alices-peer".
    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [
        {
          localHandle: "alices-peer",
          remoteEndpoint: `https://127.0.0.1:${alicePublicPort}`,
          remoteTenant: "alice-sender",
          certFingerprint: aliceIdentity.fingerprint,
        },
      ],
    });
    bobLocalPort = (bobServer.localServer.address() as any).port;

    aliceSession = await registerTestSession(
      aliceLocalPort,
      "alice-sender",
      `http://127.0.0.1:${aliceMockPort}`,
    );
    bobSession = await registerTestSession(
      bobLocalPort,
      "writer",
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
    "routes a scoped POST /bobs-peer/writer/message:send via peers.toml to Bob",
    async () => {
      // Alice's adapter sends to the scoped route on Alice's local interface.
      // No remotes.toml entry exists — only peers.toml on Alice's side.
      const response = await fetch(
        `http://127.0.0.1:${aliceLocalPort}/bobs-peer/writer/message:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": aliceSession.sessionId,
          },
          body: JSON.stringify({
            message: {
              messageId: "peers-outbound-1",
              role: "user",
              parts: [{ kind: "text", text: "Hello from Alice via peers.toml" }],
            },
          }),
        },
      );

      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.status?.state).toBe("completed");
      expect(data.artifacts?.[0]?.parts?.[0]?.text).toContain("writer responded");
    },
    15_000,
  );

  it(
    "returns 404 when peer is not in peers.toml",
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${aliceLocalPort}/unknown-peer/writer/message:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": aliceSession.sessionId,
          },
          body: JSON.stringify({
            message: {
              messageId: "peers-outbound-2",
              role: "user",
              parts: [{ kind: "text", text: "hello" }],
            },
          }),
        },
      );

      expect(response.status).toBe(404);
    },
    10_000,
  );

  it(
    "returns 404 when agent is not in peer's advertised agent list",
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${aliceLocalPort}/bobs-peer/nonexistent-agent/message:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": aliceSession.sessionId,
          },
          body: JSON.stringify({
            message: {
              messageId: "peers-outbound-3",
              role: "user",
              parts: [{ kind: "text", text: "hello" }],
            },
          }),
        },
      );

      expect(response.status).toBe(404);
    },
    10_000,
  );
});
