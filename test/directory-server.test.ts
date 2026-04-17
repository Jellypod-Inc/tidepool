import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { createDirectoryApp, type DirectoryStore } from "../src/directory-server.js";

describe("Cloud Directory Server", () => {
  let server: http.Server;
  let baseUrl: string;
  let store: DirectoryStore;

  beforeAll(async () => {
    const app = createDirectoryApp();
    store = app.store;

    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(app.app).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    store.clear();
  });

  it("POST /v1/agents/register adds an agent to the directory", async () => {
    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "rust-expert",
        description: "Rust expert agent",
        endpoint: "https://bob.example.com:9900",
        agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
      }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.handle).toBe("rust-expert");
    expect(data.status).toBe("online");
  });

  it("GET /v1/agents/search returns matching agents", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "rust-expert",
        description: "Rust and systems programming",
        endpoint: "https://bob.example.com:9900",
        agentCardUrl: "https://bob.example.com:9900/rust-expert/.well-known/agent-card.json",
      }),
    });

    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:bbbb2222",
      },
      body: JSON.stringify({
        handle: "ml-agent",
        description: "Machine learning specialist",
        endpoint: "https://carol.example.com:9900",
        agentCardUrl: "https://carol.example.com:9900/ml-agent/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/search?q=rust`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].handle).toBe("rust-expert");
  });

  it("GET /v1/agents/:handle returns a specific agent", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "specific-agent",
        description: "Specific agent",
        endpoint: "https://specific.example.com:9900",
        agentCardUrl: "https://specific.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/specific-agent`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.handle).toBe("specific-agent");
  });

  it("GET /v1/agents/:handle returns 404 for unknown agent", async () => {
    const res = await fetch(`${baseUrl}/v1/agents/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /v1/agents/heartbeat updates status", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "heartbeat-agent",
        description: "Heartbeat test",
        endpoint: "https://heartbeat.example.com:9900",
        agentCardUrl: "https://heartbeat.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({ handle: "heartbeat-agent" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe("online");
  });

  it("rejects registration update from wrong fingerprint", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "guarded-agent",
        description: "Guarded agent",
        endpoint: "https://guarded.example.com:9900",
        agentCardUrl: "https://guarded.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:imposter",
      },
      body: JSON.stringify({
        handle: "guarded-agent",
        description: "HACKED",
        endpoint: "https://evil.example.com:9900",
        agentCardUrl: "https://evil.example.com:9900/.well-known/agent-card.json",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects heartbeat from wrong fingerprint", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:aaaa1111",
      },
      body: JSON.stringify({
        handle: "heartbeat-guard",
        description: "Guarded heartbeat",
        endpoint: "https://hb-guard.example.com:9900",
        agentCardUrl: "https://hb-guard.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const res = await fetch(`${baseUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:wrong",
      },
      body: JSON.stringify({ handle: "heartbeat-guard" }),
    });

    expect(res.status).toBe(403);
  });

  it("marks agents offline when heartbeat is stale", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:stale1111",
      },
      body: JSON.stringify({
        handle: "stale-agent",
        description: "Will go stale",
        endpoint: "https://stale.example.com:9900",
        agentCardUrl: "https://stale.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const entry = store.getByHandle("stale-agent");
    if (entry) {
      entry.lastSeen = Date.now() - 120_000;
    }

    const res = await fetch(`${baseUrl}/v1/agents/stale-agent`);
    const data = (await res.json()) as any;
    expect(data.status).toBe("offline");
  });
});
