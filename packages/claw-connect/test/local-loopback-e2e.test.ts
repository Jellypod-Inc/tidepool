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
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice",
        },
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

    // The server injects metadata.from = <sender X-Agent> when forwarding to
    // the local tenant. This is the "peer" attribute: the receiver sees who
    // sent the message without the sender having to set it.
    expect(bobReceived).toMatchObject({
      message: {
        messageId: "m-1",
        role: "user",
        metadata: { from: "alice" },
      },
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

    // Before carol is registered → 404. alice is registered, so X-Agent: alice
    // passes the sender check; then the tenant lookup for carol yields 404.
    const pre = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/carol/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice",
        },
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
          headers: {
            "Content-Type": "application/json",
            "X-Agent": "alice",
          },
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

  it("supports symmetric thread continuation: alice → bob, bob → alice sharing contextId", async () => {
    const dir = tmp("cc-symmetric-");
    await runInit({ configDir: dir });

    const PUBLIC_PORT = 49740;
    const LOCAL_PORT = 49741;
    const A_ENDPOINT_PORT = 49750;
    const B_ENDPOINT_PORT = 49751;

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
    await runRegister({
      configDir: dir,
      name: "bob",
      localEndpoint: `http://127.0.0.1:${B_ENDPOINT_PORT}`,
    });

    // Both alice and bob stand up local endpoints. Each captures the body it
    // receives so we can assert the "peer" (metadata.from) and shared
    // context_id across both legs of the round-trip.
    let aliceReceived: any = null;
    let bobReceived: any = null;
    const SHARED_CTX = "ctx-shared-1";

    const aliceServer = await listenOn(A_ENDPOINT_PORT, (req, res) => {
      aliceReceived = req.body;
      res.status(200).json({
        id: "task-alice-2",
        contextId: SHARED_CTX,
        status: { state: "completed" },
        artifacts: [
          { artifactId: "r", parts: [{ kind: "text", text: "alice ack" }] },
        ],
      });
    });
    servers.push(aliceServer);

    const bobServer = await listenOn(B_ENDPOINT_PORT, (req, res) => {
      bobReceived = req.body;
      res.status(200).json({
        id: "task-bob-1",
        contextId: SHARED_CTX,
        status: { state: "completed" },
        artifacts: [
          { artifactId: "r", parts: [{ kind: "text", text: "bob ack" }] },
        ],
      });
    });
    servers.push(bobServer);

    const remotes = loadRemotesConfig(path.join(dir, "remotes.toml"));
    const handle = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });
    servers.push({ close: () => handle.close() });

    // Leg 1: alice → bob. The claw-connect daemon forwards to bob's endpoint
    // and injects metadata.from = "alice".
    const firstMsgId = "m-sym-1";
    const res1 = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice",
        },
        body: JSON.stringify({
          message: {
            messageId: firstMsgId,
            role: "user",
            parts: [{ kind: "text", text: "hi bob" }],
          },
        }),
      },
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      contextId?: string;
      artifacts: { parts: { text: string }[] }[];
    };
    expect(body1.artifacts[0].parts[0].text).toBe("bob ack");
    expect(body1.contextId).toBe(SHARED_CTX);

    // Channel event shape at bob's endpoint: peer (metadata.from), message_id
    // (messageId), and the payload text.
    expect(bobReceived.message.metadata.from).toBe("alice");
    expect(bobReceived.message.messageId).toBe(firstMsgId);
    expect(bobReceived.message.parts[0].text).toBe("hi bob");

    // Leg 2: bob → alice, continuing the same context. In the symmetric model
    // the receiver of a message becomes the sender of the reply via the same
    // `send` primitive with `thread = <contextId>` (contextId on the wire).
    const secondMsgId = "m-sym-2";
    const res2 = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/alice/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "bob",
        },
        body: JSON.stringify({
          message: {
            messageId: secondMsgId,
            role: "user",
            parts: [{ kind: "text", text: "hey alice" }],
            contextId: SHARED_CTX,
          },
        }),
      },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      contextId?: string;
      artifacts: { parts: { text: string }[] }[];
    };
    expect(body2.contextId).toBe(SHARED_CTX);

    // Alice receives the reply on her endpoint with the shared contextId and
    // peer = bob.
    expect(aliceReceived.message.metadata.from).toBe("bob");
    expect(aliceReceived.message.messageId).toBe(secondMsgId);
    expect(aliceReceived.message.contextId).toBe(SHARED_CTX);
    expect(aliceReceived.message.parts[0].text).toBe("hey alice");
  });

  it("does not persist thread state across daemon restarts (ephemeral)", async () => {
    // The claw-connect daemon itself carries no thread store — threads live in
    // the adapter's in-memory ephemeral store. After restart, the daemon has
    // no way to replay a previous conversation; the only "memory" is what the
    // caller supplies in the message body (contextId) or what the adapter
    // remembers. This test proves the daemon-level property: restarting the
    // daemon loses no state because there is none to lose, and subsequent
    // requests work purely from static config.
    const dir = tmp("cc-ephemeral-");
    await runInit({ configDir: dir });

    const PUBLIC_PORT = 49760;
    const LOCAL_PORT = 49761;
    const A_ENDPOINT_PORT = 49770;
    const B_ENDPOINT_PORT = 49771;

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
    await runRegister({
      configDir: dir,
      name: "bob",
      localEndpoint: `http://127.0.0.1:${B_ENDPOINT_PORT}`,
    });

    let bobReceived: any = null;
    const bobServer = await listenOn(B_ENDPOINT_PORT, (req, res) => {
      bobReceived = req.body;
      res.status(200).json({
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        artifacts: [
          { artifactId: "r", parts: [{ kind: "text", text: "hi" }] },
        ],
      });
    });
    servers.push(bobServer);

    // First daemon incarnation
    const remotes = loadRemotesConfig(path.join(dir, "remotes.toml"));
    const handle1 = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });

    const pre = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice",
        },
        body: JSON.stringify({
          message: {
            messageId: "m-pre",
            role: "user",
            parts: [{ kind: "text", text: "hi bob" }],
            contextId: "ctx-pre",
          },
        }),
      },
    );
    expect(pre.status).toBe(200);
    expect(bobReceived.message.contextId).toBe("ctx-pre");
    bobReceived = null;

    // Close the first incarnation. Any in-daemon thread state (there is none
    // by design) would be lost here.
    handle1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Restart. The new incarnation has no memory of ctx-pre, but static
    // config (agents) is reloaded, so the forwarding still works.
    const handle2 = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });
    servers.push({ close: () => handle2.close() });

    const post = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice",
        },
        body: JSON.stringify({
          message: {
            messageId: "m-post",
            role: "user",
            parts: [{ kind: "text", text: "still here?" }],
          },
        }),
      },
    );
    expect(post.status).toBe(200);
    // The post-restart request carries no contextId and the daemon does not
    // invent one — if one existed on the pre-restart request, it is gone.
    expect(bobReceived.message.messageId).toBe("m-post");
    expect(bobReceived.message.contextId).toBeUndefined();
    // metadata.from is still injected fresh each request (it is a function of
    // the caller's X-Agent, not of any daemon-held thread state).
    expect(bobReceived.message.metadata.from).toBe("alice");
  });
});
