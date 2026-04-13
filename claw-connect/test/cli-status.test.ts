import { describe, it, expect } from "vitest";
import { buildStatusOutput } from "../src/status.js";
import type { ServerConfig, FriendsConfig } from "../src/types.js";

const serverConfig: ServerConfig = {
  server: {
    port: 9900,
    host: "0.0.0.0",
    localPort: 9901,
    rateLimit: "100/hour",
    streamTimeoutSeconds: 300,
  },
  agents: {
    "rust-expert": {
      localEndpoint: "http://localhost:18800",
      rateLimit: "50/hour",
      description: "Expert in Rust and systems programming",
      timeoutSeconds: 30,
    },
    "code-reviewer": {
      localEndpoint: "http://localhost:18801",
      rateLimit: "30/hour",
      description: "Code review and best practices",
      timeoutSeconds: 60,
    },
  },
  connectionRequests: { mode: "auto" },
  discovery: { providers: ["static", "mdns"], cacheTtlSeconds: 300 },
};

const friendsConfig: FriendsConfig = {
  friends: {
    "alice-agent": {
      fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    "carols-ml": {
      fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      agents: ["rust-expert"],
    },
    "daves-bot": {
      fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  },
};

describe("buildStatusOutput", () => {
  it("includes server configuration", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("Public: https://0.0.0.0:9900");
    expect(output).toContain("Local: http://127.0.0.1:9901");
    expect(output).toContain("100/hour");
    expect(output).toContain("300s");
  });

  it("lists registered agents with their rate limits", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("rust-expert");
    expect(output).toContain("50/hour");
    expect(output).toContain("http://localhost:18800");
    expect(output).toContain("code-reviewer");
    expect(output).toContain("30/hour");
  });

  it("shows friend count", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);
    expect(output).toContain("3 friends");
  });

  it("shows connection request mode", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);
    expect(output).toContain("auto");
  });

  it("shows discovery providers", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);
    expect(output).toContain("static");
    expect(output).toContain("mdns");
  });

  it("handles zero agents and zero friends", () => {
    const emptyConfig: ServerConfig = {
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      agents: {},
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    };
    const emptyFriends: FriendsConfig = { friends: {} };

    const output = buildStatusOutput(emptyConfig, emptyFriends);

    expect(output).toContain("No agents registered");
    expect(output).toContain("0 friends");
  });
});
