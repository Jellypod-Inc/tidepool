import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { writePeersConfig } from "../src/peers/config.js";
import { registerTestSession, type TestSession } from "./test-helpers.js";

// Pick ports unlikely to collide with other tests in this suite.
const PUBLIC_PORT = 49810;
const LOCAL_PORT = 49811;

async function setupConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "claw-x-session-"));
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
          rateLimit: "100/minute",
          description: "",
          timeoutSeconds: 30,
        },
        bob: {
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
  writePeersConfig(path.join(dir, "peers.toml"), { peers: {} });
  return dir;
}

describe("X-Session-Id validation on local POST", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let configDir: string;
  let localUrl: string;
  let aliceSession: TestSession;

  beforeAll(async () => {
    configDir = await setupConfig();
    server = await startServer({ configDir });
    const addr = server.localServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    localUrl = `http://127.0.0.1:${addr.port}`;

    // Register alice so we have a valid sessionId to test with
    aliceSession = await registerTestSession(LOCAL_PORT, "alice", "http://127.0.0.1:19999");
  });

  afterAll(async () => {
    aliceSession?.controller.abort();
    await aliceSession?.done;
    server.close();
  });

  it("rejects POST to /:tenant/message:send with no X-Session-Id header", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects POST with unknown X-Session-Id value", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "no-such-session" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe("invalid_request");
  });
});
