import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPeers } from "../src/peers-client.js";

describe("fetchPeers", () => {
  it("fetches GET /.well-known/tidepool/peers and returns the parsed array", async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe("/.well-known/tidepool/peers");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { handle: "alice", did: null },
          { handle: "bob", did: null },
        ]),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      const peers = await fetchPeers(`http://127.0.0.1:${port}`);
      expect(peers).toEqual([
        { handle: "alice", did: null },
        { handle: "bob", did: null },
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("throws a helpful error on non-2xx", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500).end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(fetchPeers(`http://127.0.0.1:${port}`)).rejects.toThrow(
        /HTTP 500/,
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
