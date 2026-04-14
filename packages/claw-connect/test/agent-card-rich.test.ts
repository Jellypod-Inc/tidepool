import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import {
  fetchRemoteAgentCard,
  buildRichRemoteAgentCard,
} from "../src/agent-card.js";
import type { RemoteAgent } from "../src/types.js";

let mockServer: http.Server;
const mockPort = 48900;

const mockRemoteCard = {
  name: "rust-expert",
  description: "Deep expertise in Rust ownership, lifetimes, and async patterns",
  url: "https://bob.example.com:9900/rust-expert",
  version: "2.1.0",
  skills: [
    {
      id: "ownership-help",
      name: "Ownership Help",
      description: "Explains Rust ownership and borrowing",
      tags: ["rust", "ownership", "borrowing"],
    },
    {
      id: "async-patterns",
      name: "Async Patterns",
      description: "Async/await patterns in Rust",
      tags: ["rust", "async", "tokio"],
    },
  ],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "text/markdown"],
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  securitySchemes: {
    mtls: {
      type: "mtls",
      description: "mTLS with self-signed certificates",
    },
  },
  securityRequirements: [{ mtls: [] }],
};

beforeAll(() => {
  const app = express();

  app.get("/rust-expert/.well-known/agent-card.json", (_req, res) => {
    res.json(mockRemoteCard);
  });

  mockServer = app.listen(mockPort, "127.0.0.1");
});

afterAll(() => {
  mockServer?.close();
});

describe("fetchRemoteAgentCard", () => {
  it("fetches and returns an Agent Card from a URL", async () => {
    const card = await fetchRemoteAgentCard(
      `http://127.0.0.1:${mockPort}/rust-expert/.well-known/agent-card.json`,
    );

    expect(card).not.toBeNull();
    expect(card!.name).toBe("rust-expert");
    expect(card!.description).toContain("Rust ownership");
    expect(card!.skills).toHaveLength(2);
    expect(card!.skills[0].id).toBe("ownership-help");
  });

  it("returns null for unreachable URLs", async () => {
    const card = await fetchRemoteAgentCard(
      "http://127.0.0.1:59999/nonexistent/.well-known/agent-card.json",
    );
    expect(card).toBeNull();
  });

  it("returns null for non-JSON responses", async () => {
    const card = await fetchRemoteAgentCard(
      `http://127.0.0.1:${mockPort}/bad-path`,
    );
    expect(card).toBeNull();
  });
});

describe("buildRichRemoteAgentCard", () => {
  it("uses remote card skills, description, and capabilities on the local interface", () => {
    const remote: RemoteAgent = {
      localHandle: "bobs-rust",
      remoteEndpoint: "https://bob.example.com:9900",
      remoteTenant: "rust-expert",
      certFingerprint: "sha256:aaaa",
    };

    const card = buildRichRemoteAgentCard({
      remote,
      localUrl: "http://localhost:9901",
      remoteCard: mockRemoteCard,
    });

    expect(card.name).toBe("bobs-rust");
    expect(card.url).toBe("http://localhost:9901/bobs-rust");
    expect(card.description).toBe(mockRemoteCard.description);
    expect(card.skills).toEqual(mockRemoteCard.skills);
    expect(card.defaultInputModes).toEqual(mockRemoteCard.defaultInputModes);
    expect(card.defaultOutputModes).toEqual(mockRemoteCard.defaultOutputModes);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("falls back to placeholder when remoteCard is null", () => {
    const remote: RemoteAgent = {
      localHandle: "unknown-peer",
      remoteEndpoint: "https://unknown.example.com:9900",
      remoteTenant: "some-agent",
      certFingerprint: "sha256:cccc",
    };

    const card = buildRichRemoteAgentCard({
      remote,
      localUrl: "http://localhost:9901",
      remoteCard: null,
    });

    expect(card.name).toBe("unknown-peer");
    expect(card.description).toContain("Remote agent");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
  });
});
