import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runAgentAdd } from "../../src/cli/agent.js";
import { runInit } from "../../src/cli/init.js";
import { loadPeersConfig, writePeersConfig } from "../../src/peers/config.js";

describe("runAgentAdd", () => {
  let dir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-add-"));
    await runInit({ configDir: dir });
    server = http.createServer((req, res) => {
      if (req.url === "/writer/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "writer",
          description: "Writes things",
          url: "http://127.0.0.1:0/writer",
          version: "1.0.0",
          skills: [{ id: "chat", name: "chat", description: "", tags: [] }],
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          capabilities: { streaming: false, extensions: [] },
          securitySchemes: {},
          securityRequirements: [],
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  const fp = (ch: string) => "sha256:" + ch.repeat(64);

  it("adds a new peer with its agent", async () => {
    await runAgentAdd({
      configDir: dir,
      endpoint: `http://127.0.0.1:${port}`,
      agent: "writer",
      fingerprint: fp("a"),
      confirm: async () => true,
    });
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    const peer = cfg.peers["writer"];
    expect(peer).toBeDefined();
    expect(peer.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(peer.fingerprint).toBe(fp("a"));
    expect(peer.agents).toContain("writer");
  });

  it("appends an agent to an existing peer (matched by fingerprint)", async () => {
    writePeersConfig(path.join(dir, "peers.toml"), {
      peers: {
        alice: {
          fingerprint: fp("a"),
          endpoint: `http://127.0.0.1:${port}`,
          agents: ["old-agent"],
        },
      },
    });
    await runAgentAdd({
      configDir: dir,
      endpoint: `http://127.0.0.1:${port}`,
      agent: "writer",
      fingerprint: fp("a"),
      confirm: async () => true,
    });
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(cfg.peers.alice.agents.sort()).toEqual(["old-agent", "writer"]);
    expect(cfg.peers["writer"]).toBeUndefined(); // did not create new peer
  });

  it("rejects when confirm returns false", async () => {
    await expect(
      runAgentAdd({
        configDir: dir,
        endpoint: `http://127.0.0.1:${port}`,
        agent: "writer",
        fingerprint: fp("a"),
        confirm: async () => false,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(fs.existsSync(path.join(dir, "peers.toml"))).toBe(true);
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(Object.keys(cfg.peers)).toEqual([]);
  });

  it("requires --alias when peer handle would collide with a different fingerprint", async () => {
    writePeersConfig(path.join(dir, "peers.toml"), {
      peers: {
        writer: {
          fingerprint: fp("c"),
          endpoint: "https://elsewhere:9900",
          agents: ["different-agent"],
        },
      },
    });
    await expect(
      runAgentAdd({
        configDir: dir,
        endpoint: `http://127.0.0.1:${port}`,
        agent: "writer",
        fingerprint: fp("a"),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/alias/i);
  });

  it("uses --alias to avoid collision", async () => {
    writePeersConfig(path.join(dir, "peers.toml"), {
      peers: {
        writer: {
          fingerprint: fp("c"),
          endpoint: "https://elsewhere:9900",
          agents: ["different-agent"],
        },
      },
    });
    await runAgentAdd({
      configDir: dir,
      endpoint: `http://127.0.0.1:${port}`,
      agent: "writer",
      fingerprint: fp("a"),
      alias: "writer-at-port",
      confirm: async () => true,
    });
    const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
    expect(cfg.peers["writer-at-port"]).toBeDefined();
    expect(cfg.peers["writer-at-port"].agents).toEqual(["writer"]);
  });

  it("throws when fingerprint is not provided", async () => {
    await expect(
      runAgentAdd({
        configDir: dir,
        endpoint: `http://127.0.0.1:${port}`,
        agent: "writer",
        confirm: async () => true,
      } as any),
    ).rejects.toThrow(/fingerprint/i);
  });
});
