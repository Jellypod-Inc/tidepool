// packages/tidepool/test/local-loopback-e2e.test.ts
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
import { registerTestSession, type TestSession } from "./test-helpers.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function listenOn(handler: express.RequestHandler): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());
  app.post("/message\\:send", handler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

describe("local loopback — two agents on one tidepool", () => {
  const servers: Array<{ close: () => void }> = [];
  const sessions: TestSession[] = [];
  afterEach(async () => {
    for (const s of sessions) {
      s.controller.abort();
      await s.done;
    }
    sessions.length = 0;
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("agent A can send a message that is delivered to agent B's session endpoint", async () => {
    const dir = tmp("cc-loopback-");
    await runInit({ configDir: dir });

    // Write server.toml with ephemeral ports
    const serverPath = path.join(dir, "server.toml");
    fs.writeFileSync(
      serverPath,
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );

    await runRegister({ configDir: dir, name: "alice" });
    await runRegister({ configDir: dir, name: "bob" });

    // Stand up bob's local endpoint — this is what the a2a-claude-code-adapter
    // would normally run. We capture what it receives.
    let bobReceived: unknown = null;
    const { server: bobServer, port: B_ENDPOINT_PORT } = await listenOn((req, res) => {
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

    const remotes = loadRemotesConfig(path.join(dir, "remotes.toml"));
    const handle = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });
    servers.push({ close: () => handle.close() });

    const LOCAL_PORT = (handle.localServer.address() as any).port;

    // Register sessions so daemon can route to each agent's endpoint.
    // Alice is the sender — she needs a session to get a sessionId for X-Session-Id.
    const aliceSession = await registerTestSession(LOCAL_PORT, "alice", "http://127.0.0.1:19997");
    sessions.push(aliceSession);
    sessions.push(await registerTestSession(LOCAL_PORT, "bob", `http://127.0.0.1:${B_ENDPOINT_PORT}`));

    // Alice sends to Bob via the local proxy port
    const res = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": aliceSession.sessionId,
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

    // The server injects metadata.from = sender's agent name when forwarding to
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

  it("picks up an agent registered AFTER the daemon started, once session is open", async () => {
    const dir = tmp("cc-reload-");
    await runInit({ configDir: dir });

    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );
    await runRegister({ configDir: dir, name: "alice" });

    const handle = await startServer({
      configDir: dir,
      remoteAgents: [],
    });
    servers.push({ close: () => handle.close() });

    const LOCAL_PORT = (handle.localServer.address() as any).port;

    // Register alice's session — she's the sender.
    const aliceSession = await registerTestSession(LOCAL_PORT, "alice", "http://127.0.0.1:19996");
    sessions.push(aliceSession);

    // Before carol is registered → 404. Alice has an active session, so
    // X-Session-Id passes the sender check; then the tenant lookup for carol yields 404.
    const pre = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/carol/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": aliceSession.sessionId,
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

    // Register carol (config) and spin up her endpoint while the daemon keeps running.
    await runRegister({ configDir: dir, name: "carol" });
    const { server: carolServer, port: CAROL_ENDPOINT_PORT } = await listenOn((_req, res) => {
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
    // Once carol is in config AND has an active session, the daemon can route to her.
    const carolSession = await registerTestSession(LOCAL_PORT, "carol", `http://127.0.0.1:${CAROL_ENDPOINT_PORT}`);
    sessions.push(carolSession);

    // Poll until the daemon returns 200 (config reload + session both needed).
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
            "X-Session-Id": aliceSession.sessionId,
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

    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );

    await runRegister({ configDir: dir, name: "alice" });
    await runRegister({ configDir: dir, name: "bob" });

    // Both alice and bob stand up local endpoints. Each captures the body it
    // receives so we can assert the "peer" (metadata.from) and shared
    // context_id across both legs of the round-trip.
    let aliceReceived: any = null;
    let bobReceived: any = null;
    const SHARED_CTX = "ctx-shared-1";

    const { server: aliceServer, port: A_ENDPOINT_PORT } = await listenOn((req, res) => {
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

    const { server: bobServer, port: B_ENDPOINT_PORT } = await listenOn((req, res) => {
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

    const LOCAL_PORT = (handle.localServer.address() as any).port;

    // Register sessions for both alice and bob.
    const aliceSession = await registerTestSession(LOCAL_PORT, "alice", `http://127.0.0.1:${A_ENDPOINT_PORT}`);
    const bobSession = await registerTestSession(LOCAL_PORT, "bob", `http://127.0.0.1:${B_ENDPOINT_PORT}`);
    sessions.push(aliceSession);
    sessions.push(bobSession);

    // Leg 1: alice → bob. The tidepool daemon forwards to bob's endpoint
    // and injects metadata.from = "alice".
    const firstMsgId = "m-sym-1";
    const res1 = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": aliceSession.sessionId,
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
          "X-Session-Id": bobSession.sessionId,
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

  it("daemon holds no session state across restarts", async () => {
    // The tidepool daemon itself carries no thread/session state —
    // threads live in the adapter's in-memory ephemeral store, which is
    // covered separately (see adapter's thread-store.test.ts and
    // integration.test.ts). This test proves the daemon-level property:
    // restarting the daemon loses session registrations (adapters must
    // reconnect), and subsequent requests work once a new session is open.
    const dir = tmp("cc-ephemeral-");
    await runInit({ configDir: dir });

    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: 0,
          host: "0.0.0.0",
          localPort: 0,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 300,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );

    await runRegister({ configDir: dir, name: "alice" });
    await runRegister({ configDir: dir, name: "bob" });

    let bobReceived: any = null;
    const { server: bobServer, port: B_ENDPOINT_PORT } = await listenOn((req, res) => {
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

    const LOCAL_PORT = (handle1.localServer.address() as any).port;

    // Register sessions for first incarnation.
    const aliceSession1 = await registerTestSession(LOCAL_PORT, "alice", "http://127.0.0.1:19995");
    const session1 = await registerTestSession(LOCAL_PORT, "bob", `http://127.0.0.1:${B_ENDPOINT_PORT}`);

    const pre = await fetch(
      `http://127.0.0.1:${LOCAL_PORT}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": aliceSession1.sessionId,
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

    // Close the first incarnation. Sessions are lost — adapters must reconnect.
    aliceSession1.controller.abort();
    await aliceSession1.done;
    session1.controller.abort();
    await session1.done;
    handle1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Restart. The new incarnation has no memory of ctx-pre and no active sessions.
    // Since port 0 was used, we get a new ephemeral port — that's fine for this test.
    const handle2 = await startServer({
      configDir: dir,
      remoteAgents: Object.values(remotes.remotes),
    });
    servers.push({ close: () => handle2.close() });

    const LOCAL_PORT2 = (handle2.localServer.address() as any).port;

    // Register sessions for second incarnation.
    const aliceSession2 = await registerTestSession(LOCAL_PORT2, "alice", "http://127.0.0.1:19994");
    const session2 = await registerTestSession(LOCAL_PORT2, "bob", `http://127.0.0.1:${B_ENDPOINT_PORT}`);
    sessions.push(aliceSession2);
    sessions.push(session2);

    const post = await fetch(
      `http://127.0.0.1:${LOCAL_PORT2}/bob/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": aliceSession2.sessionId,
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
    // the sender's session, not of any daemon-held thread state).
    expect(bobReceived.message.metadata.from).toBe("alice");
  });
});
