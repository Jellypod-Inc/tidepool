import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import {
  buildLocalAgentCard,
  buildRemoteAgentCard,
  fetchRemoteAgentCard,
} from "../src/agent-card.js";
import type { RemoteAgent } from "../src/types.js";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { AgentCardSchema } from "../src/a2a.js";
import { runInit } from "../src/cli/init.js";

describe("buildLocalAgentCard", () => {
  it("builds a v1.0 Agent Card for a locally registered agent", () => {
    const card = buildLocalAgentCard({
      name: "rust-expert",
      description: "Expert in Rust and systems programming",
      publicUrl: "https://example.com:9900",
      tenant: "rust-expert",
    });

    expect(card.name).toBe("rust-expert");
    expect(card.description).toBe("Expert in Rust and systems programming");
    expect(card.version).toBe("1.0.0");
    expect(card.url).toBe("https://example.com:9900/rust-expert");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
    expect(card.capabilities.streaming).toBe(true);
    // v1.0: no stateTransitionHistory
    expect((card.capabilities as any).stateTransitionHistory).toBeUndefined();
    // v1.0: extensions declared under capabilities
    expect(card.capabilities.extensions).toBeDefined();
    expect(card.capabilities.extensions?.[0]?.uri).toBe(
      "https://tidepool.dev/ext/connection/v1",
    );
    // v1.0 securitySchemes shape: { type: "mtls" }
    expect(card.securitySchemes.mtls).toEqual({
      type: "mtls",
      description: expect.any(String),
    });
  });
});

describe("buildRemoteAgentCard", () => {
  it("builds an Agent Card for a remote friend on the local interface", () => {
    const remote: RemoteAgent = {
      localHandle: "bobs-rust",
      remoteEndpoint: "https://bob.example.com:9900",
      remoteTenant: "rust-expert",
      certFingerprint: "sha256:aaaa",
    };

    const card = buildRemoteAgentCard({
      remote,
      localUrl: "http://localhost:9901",
      description: "Expert in Rust and systems programming",
    });

    expect(card.name).toBe("bobs-rust");
    expect(card.url).toBe("http://localhost:9901/bobs-rust");
    expect(card.description).toBe("Expert in Rust and systems programming");
    expect(card.securitySchemes).toEqual({});
  });
});

describe("fetchRemoteAgentCard validation", () => {
  const PORT = 51771;
  let server: http.Server;

  beforeAll(() => {
    const app = express();
    app.get("/valid", (_req, res) => {
      res.json({ name: "ok-agent", url: "https://example.com/ok" });
    });
    app.get("/malformed", (_req, res) => {
      res.json({ garbage: true });
    });
    app.get("/html", (_req, res) => {
      res.type("text/plain").send("not json");
    });
    server = app.listen(PORT, "127.0.0.1");
  });

  afterAll(() => {
    server?.close();
  });

  it("returns the card when response matches the schema", async () => {
    const card = await fetchRemoteAgentCard(`http://127.0.0.1:${PORT}/valid`);
    expect(card).not.toBeNull();
    expect(card!.name).toBe("ok-agent");
  });

  it("returns null on malformed JSON response", async () => {
    const card = await fetchRemoteAgentCard(
      `http://127.0.0.1:${PORT}/malformed`,
    );
    expect(card).toBeNull();
  });

  it("returns null on non-JSON response", async () => {
    const card = await fetchRemoteAgentCard(`http://127.0.0.1:${PORT}/html`);
    expect(card).toBeNull();
  });
});

describe("v1.0 conformance: Agent Card emitted by the server validates against AgentCardSchema", () => {
  let tmpDir: string;
  let server: { close: () => void };
  let clientCert: Buffer;
  let clientKey: Buffer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-card-conformance-"));
    const configDir = path.join(tmpDir, "host");
    await generateIdentity({
      name: "probe",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    // A separate identity to present as the client when we GET the card over
    // mTLS — content of the cert doesn't matter; the request just needs to
    // complete the TLS handshake.
    const peerDir = path.join(tmpDir, "peer");
    await generateIdentity({
      name: "peer",
      certPath: path.join(peerDir, "identity.crt"),
      keyPath: path.join(peerDir, "identity.key"),
    });
    clientCert = fs.readFileSync(path.join(peerDir, "identity.crt"));
    clientKey = fs.readFileSync(path.join(peerDir, "identity.key"));

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 57700,
          host: "0.0.0.0",
          localPort: 57701,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          probe: {
            rateLimit: "50/hour",
            description: "probe",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );
    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    server = await startServer({ configDir, remoteAgents: [] });
  });

  afterAll(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses as a valid v1.0 AgentCard", async () => {
    const res = await fetch("https://127.0.0.1:57700/probe/.well-known/agent-card.json", {
      // @ts-expect-error — undici dispatcher for mTLS
      dispatcher: new UndiciAgent({
        connect: {
          cert: clientCert,
          key: clientKey,
          rejectUnauthorized: false,
        },
      }),
    });
    expect(res.ok).toBe(true);

    const card = await res.json();
    const parsed = AgentCardSchema.safeParse(card);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      // Declared our extension
      expect(parsed.data.capabilities.extensions).toBeDefined();
      expect(parsed.data.capabilities.extensions?.[0]?.uri).toBe(
        "https://tidepool.dev/ext/connection/v1",
      );
      // v1.0 does NOT have stateTransitionHistory on capabilities
      expect((parsed.data.capabilities as any).stateTransitionHistory).toBeUndefined();
      // mtls scheme uses v1.0 tagged-union shape
      expect(parsed.data.securitySchemes.mtls).toMatchObject({ type: "mtls" });
    }
  });
});

describe("local agent-card.json merges fragment from session", () => {
  it("reflects adapter-supplied description after session registers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-card-merge-"));
    await runInit({ configDir: dir });
    // Override to use unique ports for this test
    fs.writeFileSync(
      path.join(dir, "server.toml"),
      `[server]\nport = 57710\nhost = "127.0.0.1"\nlocalPort = 57712\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
    );
    const handle = await startServer({ configDir: dir });
    const port = (handle.localServer.address() as any).port;

    try {
      // Register alice via SSE (keep the connection open)
      const controller = new AbortController();
      const reg = fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:1",
            card: { description: "alice says hi", skills: [{ id: "chat", name: "chat" }] },
          }),
          signal: controller.signal,
        },
      );

      // Let the session settle
      await new Promise((r) => setTimeout(r, 100));

      const cardRes = await fetch(
        `http://127.0.0.1:${port}/alice/.well-known/agent-card.json`,
      );
      expect(cardRes.status).toBe(200);
      const card = await cardRes.json();
      expect(card.name).toBe("alice");
      expect(card.description).toBe("alice says hi");
      expect(card.skills).toEqual([{ id: "chat", name: "chat" }]);

      controller.abort();
      await reg.catch(() => {});
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 503 agent_offline when no session and not a remote agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-card-offline-"));
    await runInit({ configDir: dir });
    // Override to use unique ports for this test
    fs.writeFileSync(
      path.join(dir, "server.toml"),
      `[server]\nport = 57711\nhost = "127.0.0.1"\nlocalPort = 57713\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
    );
    const handle = await startServer({ configDir: dir });
    const port = (handle.localServer.address() as any).port;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/nobody/.well-known/agent-card.json`,
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("agent_offline");
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
