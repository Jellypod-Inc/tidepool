import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

// Test-dedicated ports — chosen to avoid collision with other test suites.
const PUBLIC_PORT = 47900;
const LOCAL_PORT = 47901;

async function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-"));
  await runInit({ configDir: dir });
  // Override server.toml with test-dedicated ports.
  fs.writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: {
        port: PUBLIC_PORT,
        host: "127.0.0.1",
        localPort: LOCAL_PORT,
        rateLimit: "1000/hour",
        streamTimeoutSeconds: 30,
      },
      agents: {},
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );
  fs.writeFileSync(
    path.join(dir, "friends.toml"),
    `[friends.bob]
fingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[friends.carol]
fingerprint = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`,
  );
  return dir;
}

describe("GET /.well-known/tidepool/peers", () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    dir = await setupTmp();
    handle = await startServer({ configDir: dir });
  });

  afterEach(async () => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an array of { handle, did } for each friend", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const handles = body.map((p: any) => p.handle).sort();
    expect(handles).toEqual(["bob", "carol"]);
    for (const p of body) {
      expect(p).toHaveProperty("did");
      expect(p.did === null || typeof p.did === "string").toBe(true);
    }
  });

  it("rejects disallowed Origin", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
      { headers: { Origin: "http://evil.example" } },
    );
    expect(res.status).toBe(403);
  });
});
