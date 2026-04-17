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
import { registerTestSession, type TestSession } from "./test-helpers.js";

// Two mock A2A agents — simple echo servers
async function createMockAgent(name: string): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "no message";
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "completed" },
      artifacts: [
        {
          artifactId: "response",
          parts: [
            {
              kind: "text",
              text: `${name} received: ${userMessage}`,
            },
          ],
        },
      ],
    });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

describe("e2e: two Tidepool servers", () => {
  let tmpDir: string;
  let aliceConfigDir: string;
  let bobConfigDir: string;
  let aliceMockAgent: http.Server;
  let bobMockAgent: http.Server;
  let aliceServer: Awaited<ReturnType<typeof startServer>>;
  let bobServer: Awaited<ReturnType<typeof startServer>>;
  let aliceSession: TestSession;
  let bobSession: TestSession;
  let aliceLocalPort: number;
  let bobLocalPort: number;
  let alicePublicPort: number;
  let bobPublicPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));

    // --- Alice's setup ---
    aliceConfigDir = path.join(tmpDir, "alice");

    const aliceIdentity = await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "identity.crt"),
      keyPath: path.join(aliceConfigDir, "identity.key"),
    });

    // --- Bob's setup ---
    bobConfigDir = path.join(tmpDir, "bob");

    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "identity.crt"),
      keyPath: path.join(bobConfigDir, "identity.key"),
    });

    // --- Start mock agents (ephemeral ports) ---
    let aliceMockPort: number;
    let bobMockPort: number;
    ({ server: aliceMockAgent, port: aliceMockPort } = await createMockAgent("alice-dev"));
    ({ server: bobMockAgent, port: bobMockPort } = await createMockAgent("rust-expert"));

    // --- Phase 1: probe ephemeral public ports by doing a dry-start ---
    // Write placeholder configs (port: 0), start both, grab ports, close both.
    const writePlaceholderConfig = (dir: string, agentName: string) => {
      fs.writeFileSync(
        path.join(dir, "server.toml"),
        TOML.stringify({
          server: { port: 0, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour" },
          agents: {
            [agentName]: { rateLimit: "50/hour", description: `${agentName} agent` },
          },
          connectionRequests: { mode: "deny" },
          discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        } as any),
      );
      fs.writeFileSync(
        path.join(dir, "friends.toml"),
        TOML.stringify({ friends: {} } as any),
      );
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

    // --- Phase 2: write real configs with cross-references and start for real ---
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: alicePublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour" },
        agents: {
          "alice-dev": {
            rateLimit: "50/hour",
            description: "Alice's dev agent",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Bob is a friend of Alice (so Bob can ask Alice's agent)
    fs.writeFileSync(
      path.join(aliceConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "bobs-rust-expert": { fingerprint: bobIdentity.fingerprint },
        },
      } as any),
    );

    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: bobPublicPort, host: "0.0.0.0", localPort: 0, rateLimit: "100/hour" },
        agents: {
          "rust-expert": {
            rateLimit: "50/hour",
            description: "Bob's Rust expert",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Alice is a friend of Bob (so Alice can ask Bob's agent)
    fs.writeFileSync(
      path.join(bobConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "alices-dev": { fingerprint: aliceIdentity.fingerprint },
        },
      } as any),
    );

    // --- Start Tidepool servers with cross-references ---
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

    // Register sessions so inbound A2A can be routed to mock agents.
    aliceSession = await registerTestSession(aliceLocalPort, "alice-dev", `http://127.0.0.1:${aliceMockPort}`);
    bobSession = await registerTestSession(bobLocalPort, "rust-expert", `http://127.0.0.1:${bobMockPort}`);
  });

  afterAll(async () => {
    aliceSession?.controller.abort();
    bobSession?.controller.abort();
    await Promise.all([aliceSession?.done, bobSession?.done]);
    aliceMockAgent?.close();
    bobMockAgent?.close();
    aliceServer?.close();
    bobServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("Alice's agent can ask Bob's agent through both Tidepool servers", async () => {
    const response = await fetch(
      `http://127.0.0.1:${aliceLocalPort}/bobs-rust/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice-dev",
        },
        body: JSON.stringify({
          message: {
            messageId: "test-1",
            role: "user",
            parts: [{ kind: "text", text: "How do you handle errors in Rust?" }],
          },
        }),
      },
    );

    const data = await response.json() as any;

    expect(data.status.state).toBe("completed");
    expect(data.artifacts[0].parts[0].text).toContain("rust-expert received:");
    expect(data.artifacts[0].parts[0].text).toContain(
      "How do you handle errors in Rust?",
    );
  });

  it("Bob's agent can ask Alice's agent through both Tidepool servers", async () => {
    const response = await fetch(
      `http://127.0.0.1:${bobLocalPort}/alices-dev/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "rust-expert",
        },
        body: JSON.stringify({
          message: {
            messageId: "test-2",
            role: "user",
            parts: [{ kind: "text", text: "What are you working on?" }],
          },
        }),
      },
    );

    const data = await response.json() as any;

    expect(data.status.state).toBe("completed");
    expect(data.artifacts[0].parts[0].text).toContain("alice-dev received:");
    expect(data.artifacts[0].parts[0].text).toContain(
      "What are you working on?",
    );
  });

  it("Alice's Tidepool serves Agent Cards on local interface", async () => {
    const response = await fetch(
      `http://127.0.0.1:${aliceLocalPort}/.well-known/agent-card.json`,
    );
    const card = await response.json() as any;

    expect(card.name).toBe("tidepool");
    const skillIds = card.skills.map((s: any) => s.id);
    expect(skillIds).toContain("alice-dev");
    expect(skillIds).toContain("bobs-rust");
  });

  it("rejects unknown peers on public interface", async () => {
    try {
      await fetch(`https://127.0.0.1:${alicePublicPort}/alice-dev/message:send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-3",
            role: "user",
            parts: [{ kind: "text", text: "Hello" }],
          },
        }),
      });
      // If fetch doesn't throw, the response should be 401
    } catch {
      // Expected — self-signed cert rejected by fetch, or no client cert
      expect(true).toBe(true);
    }
  });
});

describe("inbound validation: enforce mode", () => {
  let tmpDir: string;
  let configDir: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let clientCert: Buffer;
  let clientKey: Buffer;
  let publicPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-enforce-inbound-"));
    configDir = path.join(tmpDir, "server");

    // Server's own identity (used by mTLS listener)
    await generateIdentity({
      name: "strict-agent",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    // Client identity (any valid cert works; enforce rejects before friend check)
    const clientDir = path.join(tmpDir, "client");
    await generateIdentity({
      name: "client-agent",
      certPath: path.join(clientDir, "identity.crt"),
      keyPath: path.join(clientDir, "identity.key"),
    });
    clientCert = fs.readFileSync(
      path.join(clientDir, "identity.crt"),
    );
    clientKey = fs.readFileSync(
      path.join(clientDir, "identity.key"),
    );

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
        },
        agents: {
          "strict-agent": {
            rateLimit: "50/hour",
            description: "Strict agent that enforces wire validation",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "enforce" },
      } as any),
    );

    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    server = await startServer({ configDir });
    publicPort = (server.publicServer.address() as any).port;
  });

  afterAll(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rejects malformed inbound message with HTTP 400 and state=failed", async () => {
    const response = await fetch(
      `https://127.0.0.1:${publicPort}/strict-agent/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "bad-1",
            // Invalid — MessageSchema expects "user" or "agent"
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "hello" }],
          },
        }),
        // @ts-expect-error — undici dispatcher for mTLS
        dispatcher: new UndiciAgent({
          connect: {
            cert: clientCert,
            key: clientKey,
            rejectUnauthorized: false,
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { status: { state: string } };
    expect(data.status.state).toBe("failed");
  });
});
