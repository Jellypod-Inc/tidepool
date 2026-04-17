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
import { writePeersConfig } from "../src/peers/config.js";
import type { RemoteAgent } from "../src/types.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

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
          parts: [{ kind: "text", text: `${name} received: ${userMessage}` }],
        },
      ],
    });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

async function createSlowAgent(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (_req, _res) => {
    // Never respond — hangs forever
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

async function mTLSFetch(
  url: string,
  body: unknown,
  certPath: string,
  keyPath: string,
  senderAgent: string = "peer-agent",
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
          "X-Sender-Agent": senderAgent,
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
  let server: Awaited<ReturnType<typeof startServer>>;
  let peerCertPath: string;
  let peerKeyPath: string;
  let fastAgentSession: TestSession;
  let slowAgentSession: TestSession;
  let publicPort: number;
  let localPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-rl-"));

    serverConfigDir = path.join(tmpDir, "server");

    await generateIdentity({
      name: "server",
      certPath: path.join(serverConfigDir, "identity.crt"),
      keyPath: path.join(serverConfigDir, "identity.key"),
    });

    const peerConfigDir = path.join(tmpDir, "peer");

    const peerIdentity = await generateIdentity({
      name: "peer-agent",
      certPath: path.join(peerConfigDir, "identity.crt"),
      keyPath: path.join(peerConfigDir, "identity.key"),
    });

    peerCertPath = path.join(peerConfigDir, "identity.crt");
    peerKeyPath = path.join(peerConfigDir, "identity.key");

    // Start mock agents with ephemeral ports
    let fastAgentPort: number;
    let slowAgentPort: number;
    ({ server: mockAgent, port: fastAgentPort } = await createMockAgent("fast-agent"));
    ({ server: slowAgent, port: slowAgentPort } = await createSlowAgent());

    fs.writeFileSync(
      path.join(serverConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/minute",
        },
        agents: {
          "fast-agent": {
            rateLimit: "3/minute",
            description: "Fast agent",
            timeoutSeconds: 30,
          },
          "slow-agent": {
            rateLimit: "10/minute",
            description: "Slow agent",
            timeoutSeconds: 2,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    writePeersConfig(path.join(serverConfigDir, "peers.toml"), {
      peers: {
        "peer-agent": {
          fingerprint: peerIdentity.fingerprint,
          endpoint: "https://peer.example.com:9900",
          agents: ["peer-agent"],
        },
      },
    });

    // Register peer-agent as a remote so inbound mTLS requests can be
    // translated back to a local handle by fingerprint + X-Sender-Agent.
    const peerRemote: RemoteAgent = {
      localHandle: "peer-agent",
      remoteEndpoint: "https://peer.example.com:9900",
      remoteTenant: "peer-agent",
      certFingerprint: peerIdentity.fingerprint,
    };

    server = await startServer({
      configDir: serverConfigDir,
      remoteAgents: [peerRemote],
    });

    publicPort = (server.publicServer.address() as any).port;
    localPort = (server.localServer.address() as any).port;

    // Register sessions so inbound A2A can be routed to mock agents.
    fastAgentSession = await registerTestSession(localPort, "fast-agent", `http://127.0.0.1:${fastAgentPort}`);
    slowAgentSession = await registerTestSession(localPort, "slow-agent", `http://127.0.0.1:${slowAgentPort}`);
  });

  afterAll(async () => {
    fastAgentSession?.controller.abort();
    slowAgentSession?.controller.abort();
    await Promise.all([fastAgentSession?.done, slowAgentSession?.done]);
    mockAgent?.close();
    slowAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("allows requests within the agent rate limit", async () => {
    const resp = await mTLSFetch(
      `https://127.0.0.1:${publicPort}/fast-agent/message:send`,
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
      `https://127.0.0.1:${publicPort}/fast-agent/message:send`,
      a2aMessage("msg 2"),
      peerCertPath,
      peerKeyPath,
    );
    await mTLSFetch(
      `https://127.0.0.1:${publicPort}/fast-agent/message:send`,
      a2aMessage("msg 3"),
      peerCertPath,
      peerKeyPath,
    );

    const resp = await mTLSFetch(
      `https://127.0.0.1:${publicPort}/fast-agent/message:send`,
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
      `https://127.0.0.1:${publicPort}/slow-agent/message:send`,
      a2aMessage("this will timeout"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(504);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("slow-agent");
    expect(resp.body.artifacts[0].parts[0].text).toContain("2");
  }, 10_000);

  it("returns TASK_STATE_REJECTED for unknown peers", async () => {
    const strangerDir = path.join(tmpDir, "stranger");

    await generateIdentity({
      name: "stranger",
      certPath: path.join(strangerDir, "identity.crt"),
      keyPath: path.join(strangerDir, "identity.key"),
    });

    const resp = await mTLSFetch(
      `https://127.0.0.1:${publicPort}/fast-agent/message:send`,
      a2aMessage("let me in"),
      path.join(strangerDir, "identity.crt"),
      path.join(strangerDir, "identity.key"),
    );

    expect(resp.status).toBe(403);
    expect(resp.body.status.state).toBe("rejected");
  });

  it("returns 404 for unknown agent tenant", async () => {
    const resp = await mTLSFetch(
      `https://127.0.0.1:${publicPort}/nonexistent-agent/message:send`,
      a2aMessage("hello?"),
      peerCertPath,
      peerKeyPath,
    );

    expect(resp.status).toBe(404);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("nonexistent-agent");
  });
});
