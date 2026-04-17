import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runAgentAdd, runAgentList, runAgentRemove, runAgentRefresh } from "../../src/cli/agent.js";
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

describe("runAgentList", () => {
  it("returns the minimally-unambiguous projection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ls-"));
    try {
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
      const list = await runAgentList({ configDir: dir, localAgents: ["my-agent"] });
      expect(list).toContain("my-agent");
      expect(list).toContain("trader");        // unique
      expect(list).toContain("alice/writer");
      expect(list).toContain("bob/writer");
      expect(list).not.toContain("writer");     // ambiguous, must be scoped
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runAgentRemove", () => {
  it("removes a specific agent from its peer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rm-"));
    try {
      writePeersConfig(path.join(dir, "peers.toml"), {
        peers: {
          alice: {
            fingerprint: "sha256:" + "a".repeat(64),
            endpoint: "https://alice:9900",
            agents: ["writer", "trader"],
          },
        },
      });
      await runAgentRemove({ configDir: dir, handle: "alice/writer" });
      const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
      expect(cfg.peers.alice.agents).toEqual(["trader"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the peer entry when its last agent is removed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rm2-"));
    try {
      writePeersConfig(path.join(dir, "peers.toml"), {
        peers: {
          alice: {
            fingerprint: "sha256:" + "a".repeat(64),
            endpoint: "https://alice:9900",
            agents: ["writer"],
          },
        },
      });
      await runAgentRemove({ configDir: dir, handle: "alice/writer" });
      const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
      expect(cfg.peers.alice).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bare (non-scoped) handle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rm3-"));
    try {
      await expect(
        runAgentRemove({ configDir: dir, handle: "bare" }),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors on unknown peer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rm4-"));
    try {
      writePeersConfig(path.join(dir, "peers.toml"), { peers: {} });
      await expect(
        runAgentRemove({ configDir: dir, handle: "ghost/whatever" }),
      ).rejects.toThrow(/unknown peer/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runAgentRefresh", () => {
  let refreshServer: http.Server;
  let refreshServerPort: number;
  let serverAgents: string[] = [];

  beforeEach(async () => {
    serverAgents = [];
    refreshServer = http.createServer((req, res) => {
      if (req.url === "/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "peer-root",
          description: "",
          url: "http://127.0.0.1:0",
          version: "1.0.0",
          skills: serverAgents.map((n) => ({ id: n, name: n, description: "", tags: [] })),
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
    await new Promise<void>((r) => refreshServer.listen(0, "127.0.0.1", r));
    refreshServerPort = (refreshServer.address() as any).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => refreshServer.close(() => r()));
  });

  it("adds newly advertised agents to a peer's agents list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rf-"));
    try {
      writePeersConfig(path.join(dir, "peers.toml"), {
        peers: {
          bob: {
            fingerprint: "sha256:" + "b".repeat(64),
            endpoint: `http://127.0.0.1:${refreshServerPort}`,
            agents: ["writer"],
          },
        },
      });
      serverAgents = ["writer", "trader"];
      const diff = await runAgentRefresh({ configDir: dir, peer: "bob" });
      expect(diff.added).toEqual(["trader"]);
      const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
      expect(cfg.peers.bob.agents.sort()).toEqual(["trader", "writer"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps locally-known agents even if peer no longer advertises them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rf2-"));
    try {
      writePeersConfig(path.join(dir, "peers.toml"), {
        peers: {
          bob: {
            fingerprint: "sha256:" + "b".repeat(64),
            endpoint: `http://127.0.0.1:${refreshServerPort}`,
            agents: ["writer", "gone"],
          },
        },
      });
      serverAgents = ["writer"]; // "gone" is no longer advertised
      const diff = await runAgentRefresh({ configDir: dir, peer: "bob" });
      expect(diff.observedRemoved).toContain("gone");
      const cfg = loadPeersConfig(path.join(dir, "peers.toml"));
      expect(cfg.peers.bob.agents).toContain("gone");  // kept per "stale, don't prune"
      expect(cfg.peers.bob.agents).toContain("writer");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
