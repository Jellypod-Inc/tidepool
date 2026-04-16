// packages/claw-connect/test/local-loopback-e2e.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import http from "http";
import TOML from "@iarna/toml";
import { runInit } from "../src/cli/init.js";
import { runRegister } from "../src/cli/register.js";
import { startServer } from "../src/server.js";
import { loadRemotesConfig } from "../src/cli/remotes-config.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function listenOn(port: number, handler: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/message\\:send", handler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

describe("local loopback — two agents on one claw-connect", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(async () => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("agent A can send a message that is delivered to agent B's localEndpoint", async () => {
    const dir = tmp("cc-loopback-");
    await runInit({ configDir: dir });

    // Pick ports that won't collide with defaults or other tests
    const PUBLIC_PORT = 49700;
    const LOCAL_PORT = 49701;
    const A_ENDPOINT_PORT = 49710;
    const B_ENDPOINT_PORT = 49711;

    // Write server.toml directly with the test ports (cleaner than regex-patching)
    const serverPath = path.join(dir, "server.toml");
    fs.writeFileSync(
      serverPath,
      TOML.stringify({
        server: {
          port: PUBLIC_PORT,
          host: "0.0.0.0",
          localPort: LOCAL_PORT,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );

    await runRegister({
      configDir: dir,
      name: "alice",
      localEndpoint: `http://127.0.0.1:${A_ENDPOINT_PORT}`,
    });
    await runRegister({
      configDir: dir,
      name: "bob",
      localEndpoint: `http://127.0.0.1:${B_ENDPOINT_PORT}`,
    });

    // Stand up bob's local endpoint — this is what the a2a-claude-code-adapter
    // would normally run. We capture what it receives.
    let bobReceived: unknown = null;
    const bobServer = await listenOn(B_ENDPOINT_PORT, (req, res) => {
      bobReceived = req.body;
      res.status(200).json({
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "reply",
            parts: [{ kind: "text", text: "hi from bob" }],
          },
        ],
      });
    });
    servers.push(bobServer);

    // Alice doesn't need a listener — she's the sender in this test.

    const remotes = loadRemotesConfig(path.join(dir, "remotes.toml"));
    const handle = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });
    servers.push({ close: () => handle.close() });

    // Alice sends to Bob via the local proxy port
    const res = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "m-1",
            role: "user",
            parts: [{ kind: "text", text: "hi bob, from alice" }],
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { parts: { text: string }[] }[] };
    expect(body.artifacts[0].parts[0].text).toBe("hi from bob");
    expect(bobReceived).toMatchObject({
      message: { messageId: "m-1", role: "user" },
    });
  });

  it("picks up an agent registered AFTER the daemon started", async () => {
    const dir = tmp("cc-reload-");
    await runInit({ configDir: dir });

    const PUBLIC_PORT = 49720;
    const LOCAL_PORT = 49721;
    const A_ENDPOINT_PORT = 49730;
    const CAROL_ENDPOINT_PORT = 49731;

    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: PUBLIC_PORT,
          host: "0.0.0.0",
          localPort: LOCAL_PORT,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );
    await runRegister({
      configDir: dir,
      name: "alice",
      localEndpoint: `http://127.0.0.1:${A_ENDPOINT_PORT}`,
    });

    const handle = await startServer({
      configDir: dir,
      remoteAgents: [],
    });
    servers.push({ close: () => handle.close() });

    // Before carol is registered → 404
    const pre = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/carol/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "pre-1",
            role: "user",
            parts: [{ kind: "text", text: "hello?" }],
          },
        }),
      },
    );
    expect(pre.status).toBe(404);

    // Register carol and spin up her endpoint while the daemon keeps running.
    await runRegister({
      configDir: dir,
      name: "carol",
      localEndpoint: `http://127.0.0.1:${CAROL_ENDPOINT_PORT}`,
    });
    const carolServer = await listenOn(CAROL_ENDPOINT_PORT, (_req, res) => {
      res.status(200).json({
        id: "t",
        contextId: "c",
        status: { state: "completed" },
        artifacts: [
          { artifactId: "r", parts: [{ kind: "text", text: "hi from carol" }] },
        ],
      });
    });
    servers.push(carolServer);

    // Wait up to 2s for the holder's fs.watchFile poll (500ms) to catch up.
    const deadline = Date.now() + 2_000;
    let lastStatus = 404;
    let lastBody: any = null;
    while (Date.now() < deadline) {
      const r = await fetch(
        `http://127.0.0.1:${LOCAL_PORT}/carol/message:send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              messageId: `m-${Date.now()}`,
              role: "user",
              parts: [{ kind: "text", text: "ping" }],
            },
          }),
        },
      );
      lastStatus = r.status;
      lastBody = await r.json().catch(() => null);
      if (lastStatus === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(lastStatus).toBe(200);
    expect(lastBody.artifacts[0].parts[0].text).toBe("hi from carol");
  });
});
