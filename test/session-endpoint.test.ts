import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import { createSessionRegistry } from "../src/session/registry.js";
import { mountSessionEndpoint } from "../src/session/endpoint.js";

describe("mountSessionEndpoint — happy path", () => {
  it("returns text/event-stream and emits session.registered + peers.snapshot", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [{ handle: "bob", did: null }],
    });

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:54312",
            card: { description: "test" },
          }),
          signal: controller.signal,
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Read initial events
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 500;
      while (!buf.includes("peers.snapshot") && Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            setTimeout(() => r({ value: undefined, done: true }), 100),
          ),
        ]);
        if (done || !value) break;
        buf += decoder.decode(value);
      }
      expect(buf).toContain("event: session.registered");
      expect(buf).toContain("event: peers.snapshot");
      expect(buf).toContain('"handle":"bob"');

      expect(registry.get("alice")?.endpoint).toBe("http://127.0.0.1:54312");

      controller.abort();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("rejects a bad Origin with 403 origin_denied", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.example",
          },
          body: JSON.stringify({ endpoint: "http://127.0.0.1:1", card: {} }),
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("origin_denied");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it("rejects a missing endpoint with 400 invalid_request", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card: {} }),
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe("mountSessionEndpoint — conflict", () => {
  it("rejects a second session for the same name with 409 session_conflict", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      // Pre-populate the registry (simulates an already-active session)
      registry.register("alice", {
        endpoint: "http://127.0.0.1:1",
        card: {},
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:2",
            card: {},
          }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("session_conflict");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe("mountSessionEndpoint — cleanup", () => {
  it("deregisters the session when the SSE connection closes", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;
    mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => [],
    });

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:99",
            card: {},
          }),
          signal: controller.signal,
        },
      );
      expect(res.status).toBe(200);

      // Wait for registration to settle
      await new Promise((r) => setTimeout(r, 50));
      expect(registry.get("alice")).toBeDefined();

      // Abort the fetch, which closes the connection
      controller.abort();

      // Wait for cleanup to propagate
      await new Promise((r) => setTimeout(r, 150));
      expect(registry.get("alice")).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe("mountSessionEndpoint — peers.snapshot fanout", () => {
  it("emits an updated peers.snapshot when friends directory changes", async () => {
    const registry = createSessionRegistry();
    const app = express();
    app.use(express.json());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;

    let friends: Array<{ handle: string; did: string | null }> = [
      { handle: "bob", did: null },
    ];
    const { notifyFriendsChanged } = mountSessionEndpoint(app, {
      registry,
      port,
      friendsSnapshot: () => friends,
    });

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/tidepool/agents/alice/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "http://127.0.0.1:99",
            card: {},
          }),
          signal: controller.signal,
        },
      );

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // Drain initial session.registered + first peers.snapshot
      while (!buf.includes("peers.snapshot")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      buf = ""; // reset buffer to watch for the *next* snapshot

      // Friends change externally
      friends = [
        { handle: "bob", did: null },
        { handle: "carol", did: null },
      ];
      notifyFriendsChanged();

      // Read the new peers.snapshot
      const deadline = Date.now() + 500;
      while (!buf.includes("carol") && Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            setTimeout(() => r({ value: undefined, done: true }), 100),
          ),
        ]);
        if (done || !value) break;
        buf += decoder.decode(value);
      }
      expect(buf).toContain("carol");
      controller.abort();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
