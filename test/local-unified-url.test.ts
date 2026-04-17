import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

// Use a random high port for the public interface; local uses 0 (ephemeral).
function randomPort() {
  return 50000 + Math.floor(Math.random() * 5000);
}

describe("local interface: POST /{handle}/message:send", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-local-url-"));
    await runInit({ configDir: dir });
    // Override ports to avoid collision with defaults (9900/9901).
    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: randomPort(),
          host: "127.0.0.1",
          localPort: randomPort(),
          rateLimit: "1000/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {},
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as TOML.JsonMap),
    );
    handle = await startServer({ configDir: dir });
  });

  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 404 peer_not_found for an unknown handle", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/charlie/message:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "m-1",
            role: "user",
            parts: [{ kind: "text", text: "hi" }],
          },
        }),
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("peer_not_found");
  });

  it("rejects POST /alice/message:send with disallowed Origin", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/charlie/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example",
        },
        body: JSON.stringify({
          message: {
            messageId: "m-1",
            role: "user",
            parts: [{ kind: "text", text: "hi" }],
          },
        }),
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("origin_denied");
  });
});
