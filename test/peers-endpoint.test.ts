import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";
import { writePeersConfig } from "../src/peers/config.js";

async function setupTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-peers-"));
  await runInit({ configDir: dir });
  // Override server.toml with ephemeral ports.
  fs.writeFileSync(
    path.join(dir, "server.toml"),
    TOML.stringify({
      server: {
        port: 0,
        host: "127.0.0.1",
        localPort: 0,
        rateLimit: "1000/hour",
        streamTimeoutSeconds: 30,
      },
      agents: {},
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as TOML.JsonMap),
  );
  writePeersConfig(path.join(dir, "peers.toml"), {
    peers: {
      bob: {
        fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        endpoint: "https://bob.example.com:9900",
        agents: ["bob"],
      },
      carol: {
        fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        endpoint: "https://carol.example.com:9900",
        agents: ["carol"],
      },
    },
  });
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

  it("returns an array of { handle, did } for each peer", async () => {
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

  it("includes live local sessions alongside peers", async () => {
    const port = (handle.localServer.address() as any).port;
    const reg = handle.sessionRegistry.register("alice-local", {
      endpoint: "http://127.0.0.1:1",
      card: {
        description: "",
        skills: [{ id: "chat", name: "chat" }],
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    });
    expect(reg.ok).toBe(true);

    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
    );
    const body = await res.json();
    const handles = body.map((p: any) => p.handle).sort();
    expect(handles).toEqual(["alice-local", "bob", "carol"]);
  });

  it("filters out self via ?self=<handle>", async () => {
    const port = (handle.localServer.address() as any).port;
    handle.sessionRegistry.register("alice-local", {
      endpoint: "http://127.0.0.1:1",
      card: {
        description: "",
        skills: [{ id: "chat", name: "chat" }],
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers?self=alice-local`,
    );
    const body = await res.json();
    const handles = body.map((p: any) => p.handle).sort();
    expect(handles).toEqual(["bob", "carol"]);
  });

  it("scopes colliding handles when a handle is both a peer agent and a local session", async () => {
    const port = (handle.localServer.address() as any).port;
    handle.sessionRegistry.register("bob", {
      endpoint: "http://127.0.0.1:1",
      card: {
        description: "",
        skills: [{ id: "chat", name: "chat" }],
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/tidepool/peers`,
    );
    const body = await res.json();
    const handles = body.map((p: any) => p.handle).sort();
    // "bob" collides between local session and peer agent → both get scoped
    expect(handles).toEqual(["bob/bob", "carol", "self/bob"]);
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
