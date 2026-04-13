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
