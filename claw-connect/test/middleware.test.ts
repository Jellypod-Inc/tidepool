import { describe, it, expect } from "vitest";
import {
  checkFriend,
  checkAgentScope,
  resolveTenant,
} from "../src/middleware.js";
import type { FriendsConfig, ServerConfig } from "../src/types.js";

const friends: FriendsConfig = {
  friends: {
    "alice-agent": {
      fingerprint: "sha256:aaaa",
    },
    "carols-ml": {
      fingerprint: "sha256:bbbb",
      agents: ["rust-expert"],
    },
  },
};

const serverConfig: ServerConfig = {
  server: { port: 9900, host: "0.0.0.0", localPort: 9901, rateLimit: "100/hour" },
  agents: {
    "rust-expert": {
      localEndpoint: "http://localhost:18800",
      rateLimit: "50/hour",
      description: "Rust expert",
    },
  },
  connectionRequests: { mode: "deny" },
  discovery: { providers: ["static"], cacheTtlSeconds: 300 },
};

describe("checkFriend", () => {
  it("returns friend handle for known fingerprint", () => {
    const result = checkFriend(friends, "sha256:aaaa");
    expect(result).toEqual({ handle: "alice-agent", friend: friends.friends["alice-agent"] });
  });

  it("returns null for unknown fingerprint", () => {
    const result = checkFriend(friends, "sha256:unknown");
    expect(result).toBeNull();
  });
});

describe("checkAgentScope", () => {
  it("allows unscoped friend to access any agent", () => {
    const result = checkAgentScope(friends.friends["alice-agent"], "rust-expert");
    expect(result).toBe(true);
  });

  it("allows scoped friend to access granted agent", () => {
    const result = checkAgentScope(friends.friends["carols-ml"], "rust-expert");
    expect(result).toBe(true);
  });

  it("denies scoped friend from accessing non-granted agent", () => {
    const result = checkAgentScope(friends.friends["carols-ml"], "code-reviewer");
    expect(result).toBe(false);
  });
});

describe("resolveTenant", () => {
  it("returns agent config for known tenant", () => {
    const result = resolveTenant(serverConfig, "rust-expert");
    expect(result).toEqual(serverConfig.agents["rust-expert"]);
  });

  it("returns null for unknown tenant", () => {
    const result = resolveTenant(serverConfig, "unknown-agent");
    expect(result).toBeNull();
  });
});
