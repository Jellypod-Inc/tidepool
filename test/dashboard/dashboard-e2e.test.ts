import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../../src/identity.js";
import { startServer } from "../../src/server.js";
import { writePeersConfig } from "../../src/peers/config.js";

describe("dashboard e2e", () => {
  let tmpDir: string;
  let configDir: string;
  let server: { close: () => void };
  let localPort: number;
  let mockAgent: http.Server;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-e2e-"));
    configDir = tmpDir;

    await generateIdentity({
      name: "test-peer",
      certPath: path.join(configDir, "identity.crt"),
      keyPath: path.join(configDir, "identity.key"),
    });

    localPort = 19901 + Math.floor(Math.random() * 1000);
    const publicPort = 19900 + Math.floor(Math.random() * 1000);

    // Mock agent
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.post("/message\\:send", (_req, res) => {
      res.json({ id: "t1", contextId: "ctx-1", status: { state: "completed" }, artifacts: [] });
    });
    mockAgent = await new Promise<http.Server>((resolve) => {
      const s = agentApp.listen(0, "127.0.0.1", () => resolve(s));
    });

    const serverToml = {
      server: { port: publicPort, host: "127.0.0.1", localPort, rateLimit: "100/hour", streamTimeoutSeconds: 300 },
      agents: { "test-agent": { rateLimit: "50/hour", description: "A test agent", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    };
    fs.writeFileSync(path.join(configDir, "server.toml"), TOML.stringify(serverToml as any));

    writePeersConfig(path.join(configDir, "peers.toml"), {
      peers: {
        alice: {
          fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          endpoint: "https://alice.example.com:9900",
          agents: ["alice-dev"],
        },
      },
    });

    server = await startServer({ configDir });
  });

  afterAll(() => {
    server.close();
    mockAgent.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("GET /dashboard returns full HTML with home page", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("tidepool");
    expect(html).toContain("Home");
    expect(html).toContain("test-agent");
  });

  it("GET /dashboard/style.css returns CSS", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("--bg:");
  });

  it("GET /dashboard/htmx.min.js returns JS", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/htmx.min.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("GET /dashboard/friends returns 404 (route removed)", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/friends`);
    // friends route no longer exists — Express returns 404
    expect(res.status).toBe(404);
  });

  it("GET /dashboard/threads returns threads page", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/threads`);
    const html = await res.text();
    expect(html).toContain("Threads");
  });

  it("GET /dashboard/config returns config page with TOML content", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/config`);
    const html = await res.text();
    expect(html).toContain("server.toml");
    expect(html).toContain("peers.toml");
    expect(html).toContain("test-agent");
  });

  it("GET /dashboard/audit returns placeholder", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/audit`);
    const html = await res.text();
    expect(html).toContain("not yet implemented");
  });

  it("htmx fragment request returns content without layout", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/dashboard/threads`, {
      headers: { "HX-Request": "true" },
    });
    const html = await res.text();
    expect(html).toContain("Threads");
    expect(html).not.toContain("<!DOCTYPE html>");
  });
});
