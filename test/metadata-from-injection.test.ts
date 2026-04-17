import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import express from "express";
import http from "http";

// Pick ports unlikely to collide with other tests in this suite.
const PUBLIC_PORT = 49820;
const LOCAL_PORT = 49821;
const ALICE_ENDPOINT_PORT = 49822;
const BOB_ENDPOINT_PORT = 49823;

async function setupConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "claw-metadata-from-"));
  await runInit({ configDir: dir });
  writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: {
        port: PUBLIC_PORT,
        host: "127.0.0.1",
        localPort: LOCAL_PORT,
        rateLimit: "100/minute",
        streamTimeoutSeconds: 30,
      },
      agents: {
        alice: {
          localEndpoint: `http://127.0.0.1:${ALICE_ENDPOINT_PORT}`,
          rateLimit: "100/minute",
          description: "",
          timeoutSeconds: 30,
        },
        bob: {
          localEndpoint: `http://127.0.0.1:${BOB_ENDPOINT_PORT}`,
          rateLimit: "100/minute",
          description: "",
          timeoutSeconds: 30,
        },
      },
      connectionRequests: { mode: "deny" },
      discovery: { providers: [], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  writeFileSync(path.join(dir, "friends.toml"), "[friends]\n");
  return dir;
}

describe("metadata.from injection on local→local forward", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let bobServer: http.Server;
  let configDir: string;
  let localUrl: string;
  const received: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    configDir = await setupConfig();

    // Stand up bob's local endpoint — captures forwarded bodies.
    const app = express();
    app.use(express.json());
    app.post("/message\\:send", (req, res) => {
      received.push(req.body);
      res.status(200).json({
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "reply",
            parts: [{ kind: "text", text: "ack from bob" }],
          },
        ],
      });
    });
    bobServer = http.createServer(app);
    await new Promise<void>((resolve) =>
      bobServer.listen(BOB_ENDPOINT_PORT, "127.0.0.1", resolve),
    );

    server = await startServer({ configDir });
    const addr = server.localServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    localUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    await new Promise<void>((resolve) => bobServer.close(() => resolve()));
  });

  it("injects metadata.from = alice and preserves contextId", async () => {
    received.length = 0;
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "alice" },
      body: JSON.stringify({
        message: {
          messageId: "m-1",
          role: "user",
          contextId: "ctx-original",
          parts: [{ kind: "text", text: "hi bob" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const got = received[0] as { message: { metadata?: { from?: string }; contextId?: string } };
    expect(got.message.metadata?.from).toBe("alice");
    expect(got.message.contextId).toBe("ctx-original");
  });

  it("overwrites caller-supplied metadata.from with the X-Agent handle", async () => {
    received.length = 0;
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "alice" },
      body: JSON.stringify({
        message: {
          messageId: "m-2",
          role: "user",
          metadata: { from: "evil" },
          parts: [{ kind: "text", text: "spoof attempt" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const got = received[0] as { message: { metadata?: { from?: string } } };
    expect(got.message.metadata?.from).toBe("alice");
  });
});
