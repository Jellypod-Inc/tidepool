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

function createStreamingMockAgent(port: number, name: string): http.Server {
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

  return app.listen(port, "127.0.0.1");
}

function createHangingMockAgent(port: number): http.Server {
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

  return app.listen(port, "127.0.0.1");
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
  let server: { close: () => void };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-e2e-"));
    configDir = path.join(tmpDir, "server");
    fs.mkdirSync(path.join(configDir, "agents/streaming-agent"), {
      recursive: true,
    });

    await generateIdentity({
      name: "streaming-agent",
      certPath: path.join(configDir, "agents/streaming-agent/identity.crt"),
      keyPath: path.join(configDir, "agents/streaming-agent/identity.key"),
    });

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 59900,
          host: "0.0.0.0",
          localPort: 59901,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "streaming-agent": {
            localEndpoint: "http://127.0.0.1:59800",
            rateLimit: "50/hour",
            description: "A streaming agent",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    mockAgent = createStreamingMockAgent(59800, "streaming-agent");

    server = await startServer({ configDir });
  });

  afterAll(() => {
    mockAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("streams SSE events through the local interface for local agents", async () => {
    const response = await fetch(
      "http://127.0.0.1:59901/streaming-agent/message:stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  let server: { close: () => void };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-timeout-"));
    configDir = path.join(tmpDir, "timeout-server");
    fs.mkdirSync(path.join(configDir, "agents/slow-agent"), {
      recursive: true,
    });

    await generateIdentity({
      name: "slow-agent",
      certPath: path.join(configDir, "agents/slow-agent/identity.crt"),
      keyPath: path.join(configDir, "agents/slow-agent/identity.key"),
    });

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 59910,
          host: "0.0.0.0",
          localPort: 59911,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 1,
        },
        agents: {
          "slow-agent": {
            localEndpoint: "http://127.0.0.1:59820",
            rateLimit: "50/hour",
            description: "A slow agent that hangs",
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    hangingAgent = createHangingMockAgent(59820);

    server = await startServer({ configDir });
  });

  afterAll(() => {
    hangingAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sends state=failed status-update when stream times out with no data", async () => {
    const response = await fetch(
      "http://127.0.0.1:59911/slow-agent/message:stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
