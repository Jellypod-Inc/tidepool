import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  handleConnectionRequest,
  buildAcceptedResponse,
  buildDeniedResponse,
  deriveHandle,
  findPeerByFingerprint,
  storePendingRequest,
  loadPendingRequests,
} from "../src/handshake.js";
import type {
  ConnectionRequestConfig,
  PeersConfig,
} from "../src/types.js";

const FINGERPRINT =
  "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const ENDPOINT = "https://example.com";
const AGENT_CARD_URL = "https://example.com/.well-known/agent-card.json";

function emptyPeers(): PeersConfig {
  return { peers: {} };
}

describe("buildAcceptedResponse", () => {
  it("returns a v1.0 Message with accepted extension metadata", () => {
    const response = buildAcceptedResponse();

    expect(response.messageId).toMatch(/.+/);
    expect(response.role).toBe("agent");
    expect(response.parts[0]).toEqual({ kind: "text", text: "Connection accepted" });
    expect(
      response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "accepted" });
  });
});

describe("buildDeniedResponse", () => {
  it("returns a v1.0 Message with denied extension metadata", () => {
    const response = buildDeniedResponse("Not accepting connections");

    expect(response.messageId).toMatch(/.+/);
    expect(response.role).toBe("agent");
    expect(response.parts[0]).toEqual({ kind: "text", text: "Connection denied" });
    expect(
      response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "denied", reason: "Not accepting connections" });
  });
});

describe("deriveHandle", () => {
  it("uses the agent card name (sanitised) as handle", () => {
    expect(deriveHandle("alice-dev", FINGERPRINT)).toBe("alice-dev");
  });

  it("strips illegal characters from agent card name", () => {
    expect(deriveHandle("alice dev!", FINGERPRINT)).toBe("alicedev");
  });

  it("falls back to peer-<first8hex> when name is empty/undefined", () => {
    expect(deriveHandle(undefined, "sha256:abcdef1234567890abcdef")).toBe(
      "peer-abcdef12",
    );
    expect(deriveHandle("", "sha256:abcdef1234567890abcdef")).toBe(
      "peer-abcdef12",
    );
  });
});

describe("findPeerByFingerprint", () => {
  it("returns the handle when fingerprint matches", () => {
    const peers: PeersConfig = {
      peers: {
        "alice-dev": {
          fingerprint: FINGERPRINT,
          endpoint: ENDPOINT,
          agents: ["alice-dev"],
        },
      },
    };
    expect(findPeerByFingerprint(peers, FINGERPRINT)).toBe("alice-dev");
  });

  it("returns null when fingerprint is not present", () => {
    expect(findPeerByFingerprint(emptyPeers(), FINGERPRINT)).toBeNull();
  });

  it("is case-insensitive", () => {
    const fp = "sha256:" + "ab".repeat(32);
    const peers: PeersConfig = {
      peers: {
        bob: {
          fingerprint: fp.toUpperCase().replace("SHA256:", "sha256:"),
          endpoint: ENDPOINT,
          agents: [],
        },
      },
    };
    expect(findPeerByFingerprint(peers, fp)).toBe("bob");
  });
});

describe("handleConnectionRequest — accept mode", () => {
  it("persists accepted CONNECTION_REQUEST into peers.toml", async () => {
    const config: ConnectionRequestConfig = { mode: "accept" };
    const peers = emptyPeers();
    const writePeers = vi.fn();

    const result = await handleConnectionRequest({
      config,
      peers,
      writePeers,
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
      reason: "Want to learn Rust",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.role).toBe("agent");
    expect(
      result.response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "accepted" });

    expect(writePeers).toHaveBeenCalledOnce();
    const written: PeersConfig = writePeers.mock.calls[0][0];
    expect(written.peers["alice-dev"]).toMatchObject({
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
      agents: ["alice-dev"],
    });
  });

  it("does not create a duplicate when fingerprint already in peers.toml", async () => {
    const config: ConnectionRequestConfig = { mode: "accept" };
    const peers: PeersConfig = {
      peers: {
        "alice-dev": {
          fingerprint: FINGERPRINT,
          endpoint: ENDPOINT,
          agents: ["alice-dev"],
        },
      },
    };
    const writePeers = vi.fn();

    await handleConnectionRequest({
      config,
      peers,
      writePeers,
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
      reason: "Duplicate attempt",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(writePeers).not.toHaveBeenCalled();
  });

  it("uses fingerprint-derived handle when name collides with a different peer", async () => {
    const config: ConnectionRequestConfig = { mode: "accept" };
    const otherFingerprint = "sha256:" + "bb".repeat(32);
    const peers: PeersConfig = {
      peers: {
        "alice-dev": {
          fingerprint: otherFingerprint,
          endpoint: "https://other.example.com",
          agents: ["alice-dev"],
        },
      },
    };
    const writePeers = vi.fn();

    await handleConnectionRequest({
      config,
      peers,
      writePeers,
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
      reason: "Name collision test",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(writePeers).toHaveBeenCalledOnce();
    const written: PeersConfig = writePeers.mock.calls[0][0];
    // Should have used the fingerprint-derived handle, not "alice-dev"
    const newHandle = "peer-" + FINGERPRINT.replace("sha256:", "").slice(0, 8);
    expect(written.peers[newHandle]).toBeDefined();
    expect(written.peers[newHandle].fingerprint).toBe(FINGERPRINT);
  });
});

describe("handleConnectionRequest — deny mode", () => {
  it("rejects all connection requests without writing peers", async () => {
    const config: ConnectionRequestConfig = { mode: "deny" };
    const writePeers = vi.fn();

    const result = await handleConnectionRequest({
      config,
      peers: emptyPeers(),
      writePeers,
      fingerprint: "sha256:newcert" + "0".repeat(58),
      endpoint: ENDPOINT,
      reason: "Want to learn Rust",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.role).toBe("agent");
    expect(
      result.response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toMatchObject({ type: "denied" });
    expect(writePeers).not.toHaveBeenCalled();
  });
});

describe("handleConnectionRequest — auto mode", () => {
  it("approves when LLM returns accept and persists into peers", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Accept agents with a clear reason.",
      },
    };
    const writePeers = vi.fn();

    const result = await handleConnectionRequest({
      config,
      peers: emptyPeers(),
      writePeers,
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
      reason: "I want to learn Rust error handling patterns",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "alice-dev" }),
      evaluateWithLLM: async () => ({ decision: "accept" as const }),
    });

    expect(result.response.role).toBe("agent");
    expect(
      result.response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toEqual({ type: "accepted" });
    expect(writePeers).toHaveBeenCalledOnce();
    const written: PeersConfig = writePeers.mock.calls[0][0];
    expect(written.peers["alice-dev"]).toMatchObject({
      fingerprint: FINGERPRINT,
      endpoint: ENDPOINT,
    });
  });

  it("denies when LLM returns deny and does not write peers", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Only accept agents from the acme.com domain.",
      },
    };
    const writePeers = vi.fn();

    const result = await handleConnectionRequest({
      config,
      peers: emptyPeers(),
      writePeers,
      fingerprint: "sha256:newcert" + "0".repeat(58),
      endpoint: ENDPOINT,
      reason: "Random request",
      agentCardUrl: AGENT_CARD_URL,
      fetchAgentCard: async () => ({ name: "spammer" }),
      evaluateWithLLM: async () => ({
        decision: "deny" as const,
        reason: "Does not meet policy criteria",
      }),
    });

    expect(result.response.role).toBe("agent");
    expect(
      result.response.metadata?.["https://tidepool.dev/ext/connection/v1"],
    ).toMatchObject({ type: "denied" });
    expect(writePeers).not.toHaveBeenCalled();
  });

  it("throws if auto mode configured but no auto config", async () => {
    const config: ConnectionRequestConfig = { mode: "auto" };

    await expect(
      handleConnectionRequest({
        config,
        peers: emptyPeers(),
        writePeers: vi.fn(),
        fingerprint: "sha256:newcert" + "0".repeat(58),
        endpoint: ENDPOINT,
        reason: "test",
        agentCardUrl: "https://example.com/card.json",
        fetchAgentCard: async () => ({ name: "test" }),
      }),
    ).rejects.toThrow("auto mode requires");
  });
});

describe("pending requests storage", () => {
  let tmpDir: string;
  let pendingPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pending-"));
    pendingPath = path.join(tmpDir, "pending-requests.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("stores a pending request to disk", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(1);
    expect(requests[0].fingerprint).toBe("sha256:aaaa");
    expect(requests[0].reason).toBe("Want to learn Rust");
  });

  it("appends to existing requests", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "First request",
      agentCardUrl: "https://example.com/card1.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    storePendingRequest(pendingPath, {
      fingerprint: "sha256:bbbb",
      reason: "Second request",
      agentCardUrl: "https://example.com/card2.json",
      receivedAt: new Date("2026-04-13T01:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(2);
  });

  it("returns empty array for missing file", () => {
    const requests = loadPendingRequests(path.join(tmpDir, "nonexistent.json"));
    expect(requests).toHaveLength(0);
  });

  it("deduplicates by fingerprint", () => {
    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "First attempt",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T00:00:00Z"),
    });

    storePendingRequest(pendingPath, {
      fingerprint: "sha256:aaaa",
      reason: "Second attempt",
      agentCardUrl: "https://example.com/card.json",
      receivedAt: new Date("2026-04-13T01:00:00Z"),
    });

    const requests = loadPendingRequests(pendingPath);
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe("Second attempt");
  });
});
