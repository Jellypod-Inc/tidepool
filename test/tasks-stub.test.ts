import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

// Use random high ports to avoid collision with other tests.
function randomPort() {
  return 52000 + Math.floor(Math.random() * 5000);
}

describe("tasks/* endpoints on the local interface", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-tasks-stub-"));
    await runInit({ configDir: dir });
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

  it("GET /:handle/tasks/:id returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/alice/tasks/x-1`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
    expect(body.jsonrpc).toBe("2.0");
  });

  it("GET /:handle/tasks returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/alice/tasks`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
  });

  it("POST /:handle/tasks/:id:cancel returns UnsupportedOperationError", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/alice/tasks/x-1:cancel`,
      { method: "POST" },
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe(-32006);
  });
});
