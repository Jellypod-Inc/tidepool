import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function listenEphemeral(app: express.Application): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

/**
 * Open an SSE session for an agent on a running daemon. Returns the sessionId
 * and an AbortController for cleanup.
 */
async function openSession(
  daemonLocalPort: number,
  name: string,
  endpoint: string,
  card: Record<string, unknown> = {},
): Promise<{ controller: AbortController; sessionId: string; done: Promise<void> }> {
  const controller = new AbortController();
  let sessionId = "";
  let resolveReady: (id: string) => void;
  const ready = new Promise<string>((r) => { resolveReady = r; });

  const done = fetch(
    `http://127.0.0.1:${daemonLocalPort}/.well-known/tidepool/agents/${name}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, card }),
      signal: controller.signal,
    },
  ).then(async (res) => {
    if (!res.ok) throw new Error(`session for ${name}: HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split("\n");
          let ev = "", data = "";
          for (const ln of lines) {
            if (ln.startsWith("event: ")) ev = ln.slice(7).trim();
            else if (ln.startsWith("data: ")) data += ln.slice(6);
          }
          if (ev === "session.registered") {
            try { sessionId = JSON.parse(data).sessionId ?? ""; resolveReady(sessionId); } catch {}
          }
        }
      }
    } catch { /* abort cascades */ }
  }).catch((err) => {
    if ((err as { name?: string })?.name !== "AbortError") throw err;
  });

  // Wait for session.registered or 2s timeout
  sessionId = await Promise.race([
    ready,
    new Promise<string>((r) => setTimeout(() => r(""), 2000)),
  ]);
  return { controller, sessionId, done };
}

describe("adapter interface e2e — Task 20: full registration + card flow", () => {
  it("registers adapter via SSE and serves merged agent card", async () => {
    const dir = tmpDir("tp-e2e-task20-");
    try {
      await runInit({ configDir: dir });
      // Override server.toml with ephemeral ports
      fs.writeFileSync(
        path.join(dir, "server.toml"),
        `[server]\nport = 0\nhost = "127.0.0.1"\nlocalPort = 0\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
      );
      const handle = await startServer({ configDir: dir });
      const localPort = (handle.localServer.address() as { port: number }).port;

      // Simulate the adapter's inbound HTTP server
      const received: any[] = [];
      const adapterApp = express();
      adapterApp.use(express.json());
      adapterApp.post("/message:send", (req, res) => {
        received.push(req.body);
        res.json({
          id: req.body?.message?.messageId ?? "x",
          status: { state: "completed" },
        });
      });
      const adapterBind = await listenEphemeral(adapterApp);

      // Open SSE session declaring the adapter's endpoint
      const session = await openSession(
        localPort,
        "alice",
        `http://127.0.0.1:${adapterBind.port}`,
        { description: "e2e alice", skills: [{ id: "chat", name: "chat" }] },
      );

      try {
        // Fetch the merged agent card from the local interface
        const cardRes = await fetch(
          `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
        );
        expect(cardRes.status).toBe(200);
        const card = await cardRes.json();
        expect(card.name).toBe("alice");
        expect(card.description).toBe("e2e alice");
        expect(card.skills).toEqual([{ id: "chat", name: "chat" }]);
      } finally {
        session.controller.abort();
        await session.done.catch(() => {});
        await new Promise((r) => adapterBind.server.close(() => r(null)));
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adapter interface e2e — Task 21: session conflict", () => {
  it("rejects a second session for the same agent with 409", async () => {
    const dir = tmpDir("tp-e2e-task21-");
    try {
      await runInit({ configDir: dir });
      fs.writeFileSync(
        path.join(dir, "server.toml"),
        `[server]\nport = 0\nhost = "127.0.0.1"\nlocalPort = 0\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
      );
      const handle = await startServer({ configDir: dir });
      const localPort = (handle.localServer.address() as { port: number }).port;

      const first = await openSession(
        localPort,
        "alice",
        "http://127.0.0.1:1",
        {},
      );

      try {
        // Second registration attempt should 409
        const res = await fetch(
          `http://127.0.0.1:${localPort}/.well-known/tidepool/agents/alice/session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: "http://127.0.0.1:2", card: {} }),
          },
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe("session_conflict");
      } finally {
        first.controller.abort();
        await first.done.catch(() => {});
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adapter interface e2e — Task 22: disconnect → offline", () => {
  it("returns 503 agent_offline after the session closes", async () => {
    const dir = tmpDir("tp-e2e-task22-");
    try {
      await runInit({ configDir: dir });
      fs.writeFileSync(
        path.join(dir, "server.toml"),
        `[server]\nport = 0\nhost = "127.0.0.1"\nlocalPort = 0\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
      );
      const handle = await startServer({ configDir: dir });
      const localPort = (handle.localServer.address() as { port: number }).port;

      const session = await openSession(
        localPort,
        "alice",
        "http://127.0.0.1:99",
        {},
      );

      try {
        // Online: card resolves
        const online = await fetch(
          `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
        );
        expect(online.status).toBe(200);

        // Close session
        session.controller.abort();
        await session.done.catch(() => {});
        // Let the daemon observe the socket close
        await new Promise((r) => setTimeout(r, 200));

        // Offline: card returns 503
        const offline = await fetch(
          `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
        );
        expect(offline.status).toBe(503);
        const body = await offline.json();
        expect(body.error.code).toBe("agent_offline");
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
