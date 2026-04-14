import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import https from "https";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";

function createMockAgent(port: number, name: string): http.Server {
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
          parts: [{ kind: "text", text: `${name} received: ${userMessage}` }],
        },
      ],
    });
  });

  return app.listen(port, "127.0.0.1");
}

function createSlowAgent(port: number): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (_req, _res) => {
    // Never respond — hangs forever
  });

  return app.listen(port, "127.0.0.1");
}

async function mTLSFetch(
  url: string,
  body: unknown,
  certPath: string,
  keyPath: string,
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(body);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: JSON.parse(data),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

const a2aMessage = (text: string) => ({
  message: {
    messageId: "test-msg",
    role: "user",
    parts: [{ kind: "text", text }],
  },
});

describe("e2e: rate limiting and timeout", () => {
  let tmpDir: string;
  let serverConfigDir: string;
  let mockAgent: http.Server;
  let slowAgent: http.Server;
  let server: { close: () => void };
  let peerCertPath: string;
  let peerKeyPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-rl-"));

    serverConfigDir = path.join(tmpDir, "server");
    fs.mkdirSync(path.join(serverConfigDir, "agents/fast-agent"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(serverConfigDir, "agents/slow-agent"), {
      recursive: true,
    });

    await generateIdentity({
      name: "fast-agent",
      certPath: path.join(serverConfigDir, "agents/fast-agent/identity.crt"),
      keyPath: path.join(serverConfigDir, "agents/fast-agent/identity.key"),
    });

    await generateIdentity({
      name: "slow-agent",
      certPath: path.join(serverConfigDir, "agents/slow-agent/identity.crt"),
      keyPath: path.join(serverConfigDir, "agents/slow-agent/identity.key"),
    });

    const peerConfigDir = path.join(tmpDir, "peer");
    fs.mkdirSync(path.join(peerConfigDir, "agents/peer-agent"), {
      recursive: true,
    });

    const peerIdentity = await generateIdentity({
      name: "peer-agent",
      certPath: path.join(peerConfigDir, "agents/peer-agent/identity.crt"),
      keyPath: path.join(peerConfigDir, "agents/peer-agent/identity.key"),
    });

    peerCertPath = path.join(peerConfigDir, "agents/peer-agent/identity.crt");
    peerKeyPath = path.join(peerConfigDir, "agents/peer-agent/identity.key");

    fs.writeFileSync(
      path.join(serverConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 49900,
          host: "0.0.0.0",
          localPort: 49901,
          rateLimit: "100/minute",
        },
        agents: {
          "fast-agent": {
            localEndpoint: "http://127.0.0.1:58800",
            rateLimit: "3/minute",
            description: "Fast agent",
            timeoutSeconds: 30,
          },
          "slow-agent": {
            localEndpoint: "http://127.0.0.1:58801",
            rateLimit: "10/minute",
            description: "Slow agent",
            timeoutSeconds: 2,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(serverConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "peer-agent": { fingerprint: peerIdentity.fingerprint },
        },
      } as any),
    );

    mockAgent = createMockAgent(58800, "fast-agent");
    slowAgent = createSlowAgent(58801);

    server = await startServer({ configDir: serverConfigDir });
  });

  afterAll(() => {
    mockAgent?.close();
    slowAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("allows requests within the agent rate limit", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:49900/fast-agent/message:send",
      a2aMessage("hello"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(200);
    expect(resp.body.status.state).toBe("completed");
  });

  it("returns 429 with Retry-After when agent rate limit is exceeded", async () => {
    // First test consumed 1 fast-agent token. Drain the remaining 2.
    await mTLSFetch(
      "https://127.0.0.1:49900/fast-agent/message:send",
      a2aMessage("msg 2"),
      peerCertPath,
      peerKeyPath,
    );
    await mTLSFetch(
      "https://127.0.0.1:49900/fast-agent/message:send",
      a2aMessage("msg 3"),
      peerCertPath,
      peerKeyPath,
    );

    const resp = await mTLSFetch(
      "https://127.0.0.1:49900/fast-agent/message:send",
      a2aMessage("msg 4"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(429);
    expect(resp.headers["retry-after"]).toBeDefined();
    expect(parseInt(resp.headers["retry-after"])).toBeGreaterThan(0);
    expect(resp.body.status.state).toBe("failed");
  });

  it("returns TASK_STATE_FAILED with 504 when agent times out", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:49900/slow-agent/message:send",
      a2aMessage("this will timeout"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(504);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("slow-agent");
    expect(resp.body.artifacts[0].parts[0].text).toContain("2");
  }, 10_000);

  it("returns TASK_STATE_REJECTED for non-friends", async () => {
    const strangerDir = path.join(tmpDir, "stranger");
    fs.mkdirSync(path.join(strangerDir, "agents/stranger"), {
      recursive: true,
    });

    await generateIdentity({
      name: "stranger",
      certPath: path.join(strangerDir, "agents/stranger/identity.crt"),
      keyPath: path.join(strangerDir, "agents/stranger/identity.key"),
    });

    const resp = await mTLSFetch(
      "https://127.0.0.1:49900/fast-agent/message:send",
      a2aMessage("let me in"),
      path.join(strangerDir, "agents/stranger/identity.crt"),
      path.join(strangerDir, "agents/stranger/identity.key"),
    );

    expect(resp.status).toBe(403);
    expect(resp.body.status.state).toBe("rejected");
  });

  it("returns 404 for unknown agent tenant", async () => {
    const resp = await mTLSFetch(
      "https://127.0.0.1:49900/nonexistent-agent/message:send",
      a2aMessage("hello?"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(404);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("nonexistent-agent");
  });
});
