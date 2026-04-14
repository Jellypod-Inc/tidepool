import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type http from "http";
import {
  buildLocalAgentCard,
  buildRemoteAgentCard,
  fetchRemoteAgentCard,
} from "../src/agent-card.js";
import type { RemoteAgent } from "../src/types.js";

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
      "https://clawconnect.dev/ext/connection/v1",
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
