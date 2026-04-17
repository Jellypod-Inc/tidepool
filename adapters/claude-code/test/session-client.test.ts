import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import { openSession } from "../src/session-client.js";

describe("openSession", () => {
  it("POSTs registration payload and yields initial peers snapshot", async () => {
    const app = express();
    app.use(express.json());
    let received: any = null;
    app.post("/.well-known/tidepool/agents/:name/session", (req, res) => {
      received = { name: req.params.name, body: req.body };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: session.registered\ndata: {"sessionId":"s-1"}\n\n`);
      res.write(`event: peers.snapshot\ndata: [{"handle":"bob","did":null}]\n\n`);
      // Leave open (simulate a real SSE session)
    });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const daemonPort = (server.address() as any).port;

    try {
      const peers: any[] = [];
      const handle = await openSession({
        daemonUrl: `http://127.0.0.1:${daemonPort}`,
        name: "alice",
        endpoint: "http://127.0.0.1:9999",
        card: { description: "test" },
        onPeers: (snap) => peers.push(snap),
      });

      // Wait for initial events
      await new Promise((r) => setTimeout(r, 100));

      expect(received?.name).toBe("alice");
      expect(received?.body?.endpoint).toBe("http://127.0.0.1:9999");
      expect(received?.body?.card?.description).toBe("test");
      expect(handle.sessionId).toBe("s-1");
      expect(peers).toHaveLength(1);
      expect(peers[0][0].handle).toBe("bob");

      await handle.close();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("rejects when daemon returns non-200", async () => {
    const app = express();
    app.use(express.json());
    app.post("/.well-known/tidepool/agents/:name/session", (req, res) => {
      res.status(409).json({ error: { code: "session_conflict", message: "..." } });
    });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const daemonPort = (server.address() as any).port;

    try {
      await expect(
        openSession({
          daemonUrl: `http://127.0.0.1:${daemonPort}`,
          name: "alice",
          endpoint: "http://127.0.0.1:1",
          card: {},
          onPeers: () => {},
        }),
      ).rejects.toThrow(/409/);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
