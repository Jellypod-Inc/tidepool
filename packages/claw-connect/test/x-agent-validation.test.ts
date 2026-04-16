import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";

// Pick ports unlikely to collide with other tests in this suite.
const PUBLIC_PORT = 49810;
const LOCAL_PORT = 49811;

async function setupConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "claw-x-agent-"));
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
          localEndpoint: "http://127.0.0.1:18801",
          rateLimit: "100/minute",
          description: "",
          timeoutSeconds: 30,
        },
        bob: {
          localEndpoint: "http://127.0.0.1:18802",
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

describe("X-Agent validation on local POST", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let configDir: string;
  let localUrl: string;

  beforeAll(async () => {
    configDir = await setupConfig();
    server = await startServer({ configDir });
    const addr = server.localServer.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    localUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
  });

  it("rejects POST to /:tenant/message:send with no X-Agent header", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with unknown X-Agent value", async () => {
    const res = await fetch(`${localUrl}/bob/message:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent": "unknown" },
      body: JSON.stringify({
        message: { messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
      }),
    });
    expect(res.status).toBe(403);
  });
});
