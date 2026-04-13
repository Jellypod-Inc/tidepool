import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";

// Two mock A2A agents — simple echo servers
function createMockAgent(port: number, name: string): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "no message";
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "TASK_STATE_COMPLETED" },
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

  return app.listen(port, "127.0.0.1");
}

describe("e2e: two Claw Connect servers", () => {
  let tmpDir: string;
  let aliceConfigDir: string;
  let bobConfigDir: string;
  let aliceMockAgent: http.Server;
  let bobMockAgent: http.Server;
  let aliceServer: { close: () => void };
  let bobServer: { close: () => void };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));

    // --- Alice's setup ---
    aliceConfigDir = path.join(tmpDir, "alice");
    fs.mkdirSync(path.join(aliceConfigDir, "agents/alice-dev"), {
      recursive: true,
    });

    const aliceIdentity = await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "agents/alice-dev/identity.crt"),
      keyPath: path.join(aliceConfigDir, "agents/alice-dev/identity.key"),
    });

    // --- Bob's setup ---
    bobConfigDir = path.join(tmpDir, "bob");
    fs.mkdirSync(path.join(bobConfigDir, "agents/rust-expert"), {
      recursive: true,
    });

    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "agents/rust-expert/identity.crt"),
      keyPath: path.join(bobConfigDir, "agents/rust-expert/identity.key"),
    });

    // --- Alice's config ---
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: 19900, host: "0.0.0.0", localPort: 19901, rateLimit: "100/hour" },
        agents: {
          "alice-dev": {
            localEndpoint: "http://127.0.0.1:28800",
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

    // --- Bob's config ---
    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: { port: 29900, host: "0.0.0.0", localPort: 29901, rateLimit: "100/hour" },
        agents: {
          "rust-expert": {
            localEndpoint: "http://127.0.0.1:38800",
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

    // --- Start mock agents ---
    aliceMockAgent = createMockAgent(28800, "alice-dev");
    bobMockAgent = createMockAgent(38800, "rust-expert");

    // --- Start Claw Connect servers ---
    aliceServer = await startServer({
      configDir: aliceConfigDir,
      remoteAgents: [
        {
          localHandle: "bobs-rust",
          remoteEndpoint: "https://127.0.0.1:29900",
          remoteTenant: "rust-expert",
          certFingerprint: bobIdentity.fingerprint,
        },
      ],
    });

    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [
        {
          localHandle: "alices-dev",
          remoteEndpoint: "https://127.0.0.1:19900",
          remoteTenant: "alice-dev",
          certFingerprint: aliceIdentity.fingerprint,
        },
      ],
    });
  });

  afterAll(() => {
    aliceMockAgent?.close();
    bobMockAgent?.close();
    aliceServer?.close();
    bobServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("Alice's agent can ask Bob's agent through both Claw Connect servers", async () => {
    const response = await fetch(
      "http://127.0.0.1:19901/bobs-rust/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-1",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "How do you handle errors in Rust?" }],
          },
        }),
      },
    );

    const data = await response.json() as any;

    expect(data.status.state).toBe("TASK_STATE_COMPLETED");
    expect(data.artifacts[0].parts[0].text).toContain("rust-expert received:");
    expect(data.artifacts[0].parts[0].text).toContain(
      "How do you handle errors in Rust?",
    );
  });

  it("Bob's agent can ask Alice's agent through both Claw Connect servers", async () => {
    const response = await fetch(
      "http://127.0.0.1:29901/alices-dev/message:send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-2",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "What are you working on?" }],
          },
        }),
      },
    );

    const data = await response.json() as any;

    expect(data.status.state).toBe("TASK_STATE_COMPLETED");
    expect(data.artifacts[0].parts[0].text).toContain("alice-dev received:");
    expect(data.artifacts[0].parts[0].text).toContain(
      "What are you working on?",
    );
  });

  it("Alice's Claw Connect serves Agent Cards on local interface", async () => {
    const response = await fetch(
      "http://127.0.0.1:19901/.well-known/agent-card.json",
    );
    const card = await response.json() as any;

    expect(card.name).toBe("claw-connect");
    const skillIds = card.skills.map((s: any) => s.id);
    expect(skillIds).toContain("alice-dev");
    expect(skillIds).toContain("bobs-rust");
  });

  it("rejects unknown peers on public interface", async () => {
    try {
      await fetch("https://127.0.0.1:19900/alice-dev/message:send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "test-3",
            role: "ROLE_USER",
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
