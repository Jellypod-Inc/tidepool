import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { createDirectoryApp, type DirectoryStore } from "../../src/directory-server.js";
import { DirectoryProvider } from "../../src/discovery/directory-provider.js";

describe("DirectoryProvider", () => {
  let server: http.Server;
  let baseUrl: string;
  let store: DirectoryStore;

  beforeAll(async () => {
    const dir = createDirectoryApp();
    store = dir.store;

    server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer(dir.app).listen(0, "127.0.0.1", () => {
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

  it("has name 'directory'", () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:test-fp");
    expect(provider.name).toBe("directory");
  });

  it("advertise registers the agent with the directory", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:advertise-fp");

    await provider.advertise({
      handle: "dir-agent",
      description: "Directory test agent",
      endpoint: "https://dir.example.com:9900",
      agentCardUrl: "https://dir.example.com:9900/.well-known/agent-card.json",
      status: "online",
    });

    const res = await fetch(`${baseUrl}/v1/agents/dir-agent`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.handle).toBe("dir-agent");
  });

  it("search queries the directory", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:seed-fp",
      },
      body: JSON.stringify({
        handle: "search-agent",
        description: "Agent for search testing",
        endpoint: "https://search.example.com:9900",
        agentCardUrl: "https://search.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const results = await provider.search({ query: "search" });

    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe("search-agent");
    expect(results[0].status).toBe("online");
  });

  it("resolve returns a specific agent", async () => {
    await fetch(`${baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": "sha256:resolve-fp",
      },
      body: JSON.stringify({
        handle: "resolve-agent",
        description: "Agent to resolve",
        endpoint: "https://resolve.example.com:9900",
        agentCardUrl: "https://resolve.example.com:9900/.well-known/agent-card.json",
      }),
    });

    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const result = await provider.resolve("resolve-agent");

    expect(result).not.toBeNull();
    expect(result!.handle).toBe("resolve-agent");
  });

  it("resolve returns null for unknown handle", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    const result = await provider.resolve("nonexistent");
    expect(result).toBeNull();
  });

  it("deadvertise is a no-op", async () => {
    const provider = new DirectoryProvider(baseUrl, "sha256:client-fp");
    await provider.deadvertise();
  });
});

describe("DirectoryProvider validation", () => {
  // A bogus directory that returns malformed payloads — simulates a compromised
  // or buggy directory server. The provider must not propagate garbage.
  let bogusServer: http.Server;
  let bogusUrl: string;

  beforeAll(async () => {
    const http2 = await import("http");
    const express = (await import("express")).default;
    const app = express();

    app.get("/v1/agents/search", (_req, res) => {
      res.json({ agents: [{ handle: "only-handle" /* missing fields */ }] });
    });

    app.get("/v1/agents/:handle", (_req, res) => {
      res.json({ not: "a valid entry" });
    });

    bogusServer = await new Promise<http.Server>((resolve) => {
      const s = http2.createServer(app).listen(0, "127.0.0.1", () => {
        resolve(s);
      });
    });

    const addr = bogusServer.address() as { port: number };
    bogusUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    bogusServer?.close();
  });

  it("search returns [] when the directory returns malformed entries", async () => {
    const provider = new DirectoryProvider(bogusUrl, "sha256:client-fp");
    const results = await provider.search({ query: "anything" });
    expect(results).toEqual([]);
  });

  it("resolve returns null when the directory returns a malformed entry", async () => {
    const provider = new DirectoryProvider(bogusUrl, "sha256:client-fp");
    const result = await provider.resolve("anything");
    expect(result).toBeNull();
  });
});
