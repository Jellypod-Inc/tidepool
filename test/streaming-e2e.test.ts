import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { formatSseEvent } from "../src/a2a.js";
import { writePeersConfig } from "../src/peers/config.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as any).port);
    });
  });
}

async function createStreamingMockAgent(name: string): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const taskId = `task-stream-${name}`;
    const contextId = `ctx-stream-${name}`;

    res.write(
      formatSseEvent({
        kind: "status-update",
        taskId,
        contextId,
        status: { state: "working" },
      }),
    );

    setTimeout(() => {
      res.write(
        formatSseEvent({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: "chunk-1",
            parts: [{ kind: "text", text: `Hello from ${name}` }],
          },
        }),
      );
    }, 50);

    setTimeout(() => {
      res.write(
        formatSseEvent({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "completed" },
        }),
      );
      res.end();
    }, 100);
  });

  const server = http.createServer(app);
  const port = await listenEphemeral(server);
  return { server, port };
}

async function createHangingMockAgent(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // flushHeaders forces headers onto the wire so fetch() can return the
    // Response. Without this, writeHead buffers and the client's fetch hangs.
    res.flushHeaders();
    // Never write a body — the proxy's stream timeout should fire.
  });

  const server = http.createServer(app);
  const port = await listenEphemeral(server);
  return { server, port };
}

async function collectSSEEvents(response: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {
          // skip malformed
        }
      }
    }
  }

  return events;
}

describe("e2e: SSE streaming through local interface", () => {
  let tmpDir: string;
  let configDir: string;
  let mockAgent: http.Server;
  let server: Awaited<ReturnType<typeof startServer>>;
  let agentSession: TestSession;
  let localPort: number;
  let mockAgentPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-e2e-"));
    configDir = path.join(tmpDir, "server");

    await generateIdentity({
      name: "streaming-agent",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    ({ server: mockAgent, port: mockAgentPort } = await createStreamingMockAgent("streaming-agent"));

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "streaming-agent": {
            rateLimit: "50/hour",
            description: "A streaming agent",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    writePeersConfig(path.join(configDir, "peers.toml"), { peers: {} });

    server = await startServer({ configDir });
    localPort = (server.localServer.address() as any).port;
    agentSession = await registerTestSession(localPort, "streaming-agent", `http://127.0.0.1:${mockAgentPort}`);
  });

  afterAll(async () => {
    agentSession?.controller.abort();
    await agentSession?.done;
    mockAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("streams SSE events through the local interface for local agents", async () => {
    const response = await fetch(
      `http://127.0.0.1:${localPort}/streaming-agent/message:stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": agentSession.sessionId,
        },
        body: JSON.stringify({
          message: {
            messageId: "stream-test-1",
            role: "user",
            parts: [{ kind: "text", text: "Stream me a response" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);

    expect(events.length).toBeGreaterThanOrEqual(3);

    const statusEvents = events.filter(
      (e: any) => e.kind === "status-update",
    );
    const artifactEvents = events.filter(
      (e: any) => e.kind === "artifact-update",
    );

    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(artifactEvents.length).toBeGreaterThanOrEqual(1);

    expect((statusEvents[0] as any).status.state).toBe("working");
    expect((statusEvents[statusEvents.length - 1] as any).status.state).toBe(
      "completed",
    );

    expect((artifactEvents[0] as any).artifact.parts[0].text).toContain(
      "Hello from streaming-agent",
    );
  });
});

describe("e2e: SSE stream timeout", () => {
  let tmpDir: string;
  let configDir: string;
  let hangingAgent: http.Server;
  let server: Awaited<ReturnType<typeof startServer>>;
  let agentSession: TestSession;
  let localPort: number;
  let hangingAgentPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-timeout-"));
    configDir = path.join(tmpDir, "timeout-server");

    await generateIdentity({
      name: "slow-agent",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    ({ server: hangingAgent, port: hangingAgentPort } = await createHangingMockAgent());

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 1,
        },
        agents: {
          "slow-agent": {
            rateLimit: "50/hour",
            description: "A slow agent that hangs",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    writePeersConfig(path.join(configDir, "peers.toml"), { peers: {} });

    server = await startServer({ configDir });
    localPort = (server.localServer.address() as any).port;
    agentSession = await registerTestSession(localPort, "slow-agent", `http://127.0.0.1:${hangingAgentPort}`);
  });

  afterAll(async () => {
    agentSession?.controller.abort();
    await agentSession?.done;
    hangingAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sends state=failed status-update when stream times out with no data", async () => {
    const response = await fetch(
      `http://127.0.0.1:${localPort}/slow-agent/message:stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": agentSession.sessionId,
        },
        body: JSON.stringify({
          message: {
            messageId: "timeout-test-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello slow agent" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);

    const failEvents = events.filter(
      (e: any) => e.kind === "status-update" && e.status?.state === "failed",
    );
    expect(failEvents.length).toBe(1);
  }, 10000);
});

// --- Upstream SSE validation in enforce mode ---

async function createMalformedSseMockAgent(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Emit exactly one SSE event with a verbose-dialect task state that is
    // invalid under StreamEventSchema (it expects "completed", not
    // "TASK_STATE_COMPLETED"). In enforce mode, proxySSEStream should tear
    // the stream down and emit a synthetic failed status-update.
    res.write(
      formatSseEvent({
        kind: "status-update",
        taskId: "t1",
        contextId: "c1",
        status: { state: "TASK_STATE_COMPLETED" },
      }),
    );
    res.end();
  });

  const server = http.createServer(app);
  const port = await listenEphemeral(server);
  return { server, port };
}

describe("upstream SSE validation: enforce mode", () => {
  let tmpDir: string;
  let configDir: string;
  let mockAgent: http.Server;
  let server: Awaited<ReturnType<typeof startServer>>;
  let agentSession: TestSession;
  let localPort: number;
  let mockAgentPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-enforce-"));
    configDir = path.join(tmpDir, "enforce-server");

    await generateIdentity({
      name: "strict-stream-agent",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    ({ server: mockAgent, port: mockAgentPort } = await createMalformedSseMockAgent());

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "strict-stream-agent": {
            rateLimit: "50/hour",
            description: "Streaming agent whose upstream sends malformed SSE",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "enforce" },
      } as any),
    );

    writePeersConfig(path.join(configDir, "peers.toml"), { peers: {} });

    server = await startServer({ configDir });
    localPort = (server.localServer.address() as any).port;
    agentSession = await registerTestSession(localPort, "strict-stream-agent", `http://127.0.0.1:${mockAgentPort}`);
  });

  afterAll(async () => {
    agentSession?.controller.abort();
    await agentSession?.done;
    mockAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("tears down stream and emits failed status-update on malformed upstream event", async () => {
    const response = await fetch(
      `http://127.0.0.1:${localPort}/strict-stream-agent/message:stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": agentSession.sessionId,
        },
        body: JSON.stringify({
          message: {
            messageId: "enforce-stream-1",
            role: "user",
            parts: [{ kind: "text", text: "Stream me" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);
    expect(events.length).toBe(1);

    const last: any = events[events.length - 1];
    expect(last.kind).toBe("status-update");
    expect(last.status.state).toBe("failed");
    expect(last.status.message.parts[0].text).toContain(
      "Upstream sent malformed event",
    );
  });
});

// --- Upstream invalid-JSON SSE data: enforce rejection ---

async function createInvalidJsonSseMockAgent(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // A raw `data:` line whose JSON fails to parse. Before this fix, such
    // lines slipped through enforce mode because parseSseLine collapsed them
    // into the same null bucket as legitimate non-data lines.
    res.write("data: {broken\n\n");
    res.end();
  });

  const server = http.createServer(app);
  const port = await listenEphemeral(server);
  return { server, port };
}

describe("upstream SSE validation: enforce rejects invalid-JSON data", () => {
  let tmpDir: string;
  let configDir: string;
  let mockAgent: http.Server;
  let server: Awaited<ReturnType<typeof startServer>>;
  let agentSession: TestSession;
  let localPort: number;
  let mockAgentPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-bad-json-"));
    configDir = path.join(tmpDir, "bad-json-server");

    await generateIdentity({
      name: "bad-json-agent",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    ({ server: mockAgent, port: mockAgentPort } = await createInvalidJsonSseMockAgent());

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "bad-json-agent": {
            rateLimit: "50/hour",
            description: "Streaming agent whose upstream sends invalid JSON",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "enforce" },
      } as any),
    );

    writePeersConfig(path.join(configDir, "peers.toml"), { peers: {} });

    server = await startServer({ configDir });
    localPort = (server.localServer.address() as any).port;
    agentSession = await registerTestSession(localPort, "bad-json-agent", `http://127.0.0.1:${mockAgentPort}`);
  });

  afterAll(async () => {
    agentSession?.controller.abort();
    await agentSession?.done;
    mockAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("tears down stream and emits failed status-update when upstream sends unparseable JSON", async () => {
    const response = await fetch(
      `http://127.0.0.1:${localPort}/bad-json-agent/message:stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": agentSession.sessionId,
        },
        body: JSON.stringify({
          message: {
            messageId: "enforce-bad-json-1",
            role: "user",
            parts: [{ kind: "text", text: "Stream me" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);
    // collectSSEEvents silently skips malformed data lines, so only the
    // synthetic failed status-update should come through.
    expect(events.length).toBe(1);

    const last: any = events[events.length - 1];
    expect(last.kind).toBe("status-update");
    expect(last.status.state).toBe("failed");
    expect(last.status.message.parts[0].text).toContain(
      "Upstream sent unparseable SSE data",
    );
  });
});
