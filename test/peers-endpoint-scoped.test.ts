import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writePeersConfig } from "../src/peers/config.js";

async function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-scoped-"));
  await runInit({ configDir: dir });
  fs.writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: { port: 0, host: "127.0.0.1", localPort: 0, rateLimit: "1000/hour", streamTimeoutSeconds: 30 },
      agents: { "my-writer": { rateLimit: "100/hour" }, "my-trader": { rateLimit: "100/hour" } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );
  writePeersConfig(path.join(dir, "peers.toml"), {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["writer", "trader"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer"],
      },
    },
  });
  return dir;
}

describe("GET /.well-known/tidepool/peers (scoped projection)", () => {
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

  it("returns scoped handles only for collisions; bare otherwise", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/tidepool/peers`);
    expect(res.status).toBe(200);
    const body: Array<{ handle: string }> = await res.json();
    const handles = body.map((p) => p.handle).sort();

    // Local agents from server.toml — unique names, must be bare
    expect(handles).toContain("my-writer");
    expect(handles).toContain("my-trader");

    // "writer" appears in both alice and bob → must be scoped
    expect(handles).toContain("alice/writer");
    expect(handles).toContain("bob/writer");
    expect(handles).not.toContain("writer");

    // "trader" only in alice, unique across all peers → bare
    expect(handles).toContain("trader");
  });

  it("filters out self via ?self= when self is a local agent", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers?self=my-writer`,
    );
    expect(res.status).toBe(200);
    const body: Array<{ handle: string }> = await res.json();
    const handles = body.map((p) => p.handle).sort();

    expect(handles).not.toContain("my-writer");
    expect(handles).toContain("my-trader");
    expect(handles).toContain("alice/writer");
    expect(handles).toContain("bob/writer");
    expect(handles).toContain("trader");
  });

  it("returns { handle, did } shape for each entry", async () => {
    const port = (handle.localServer.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/tidepool/peers`);
    const body: Array<{ handle: string; did: string | null }> = await res.json();
    for (const p of body) {
      expect(p).toHaveProperty("handle");
      expect(p).toHaveProperty("did");
      expect(p.did === null || typeof p.did === "string").toBe(true);
    }
  });
});
