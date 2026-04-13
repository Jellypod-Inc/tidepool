import { describe, it, expect } from "vitest";
import { loadServerConfig, loadFriendsConfig } from "../src/config.js";
import path from "path";

const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");

describe("loadServerConfig", () => {
  it("loads and parses server.toml", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server.toml"));

    expect(config.server.port).toBe(9900);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.localPort).toBe(9901);
    expect(config.server.rateLimit).toBe("100/hour");
    expect(config.agents["rust-expert"].localEndpoint).toBe(
      "http://localhost:18800",
    );
    expect(config.agents["rust-expert"].rateLimit).toBe("50/hour");
    expect(config.agents["rust-expert"].description).toBe(
      "Expert in Rust and systems programming",
    );
    expect(config.agents["code-reviewer"]).toBeDefined();
    expect(config.connectionRequests.mode).toBe("deny");
  });

  it("throws on missing file", () => {
    expect(() => loadServerConfig("/nonexistent/path.toml")).toThrow();
  });
});

describe("loadFriendsConfig", () => {
  it("loads and parses friends.toml", () => {
    const config = loadFriendsConfig(path.join(fixturesDir, "friends.toml"));

    expect(config.friends["alice-agent"].fingerprint).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(config.friends["alice-agent"].agents).toBeUndefined();
    expect(config.friends["carols-ml"].agents).toEqual(["rust-expert"]);
  });

  it("returns empty friends on missing file", () => {
    const config = loadFriendsConfig("/nonexistent/friends.toml");
    expect(config.friends).toEqual({});
  });
});
