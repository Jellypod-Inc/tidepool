import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  handleConnectionRequest,
  buildAcceptedResponse,
  buildDeniedResponse,
  deriveHandle,
  storePendingRequest,
  loadPendingRequests,
} from "../src/handshake.js";
import type {
  ConnectionRequestConfig,
  FriendsConfig,
} from "../src/types.js";

describe("buildAcceptedResponse", () => {
  it("returns an A2A task with TASK_STATE_COMPLETED and accepted extension", () => {
    const response = buildAcceptedResponse();

    expect(response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0].parts[0].text).toBe("Connection accepted");
    expect(
      response.artifacts[0].metadata["https://clawconnect.dev/ext/connection/v1"]
        .type,
    ).toBe("accepted");
  });
});

describe("buildDeniedResponse", () => {
  it("returns an A2A task with TASK_STATE_REJECTED and denied extension", () => {
    const response = buildDeniedResponse("Not accepting connections");

    expect(response.status.state).toBe("TASK_STATE_REJECTED");
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0].parts[0].text).toBe("Connection denied");
    expect(
      response.artifacts[0].metadata["https://clawconnect.dev/ext/connection/v1"]
        .type,
    ).toBe("denied");
    expect(
      response.artifacts[0].metadata["https://clawconnect.dev/ext/connection/v1"]
        .reason,
    ).toBe("Not accepting connections");
  });
});

describe("deriveHandle", () => {
  it("uses the agent card name as handle", () => {
    const handle = deriveHandle("alice-dev", {});
    expect(handle).toBe("alice-dev");
  });

  it("appends suffix on collision", () => {
    const existing: FriendsConfig = {
      friends: {
        "alice-dev": { fingerprint: "sha256:aaaa" },
      },
    };
    const handle = deriveHandle("alice-dev", existing);
    expect(handle).toBe("alice-dev-2");
  });

  it("increments suffix on multiple collisions", () => {
    const existing: FriendsConfig = {
      friends: {
        "alice-dev": { fingerprint: "sha256:aaaa" },
        "alice-dev-2": { fingerprint: "sha256:bbbb" },
      },
    };
    const handle = deriveHandle("alice-dev", existing);
    expect(handle).toBe("alice-dev-3");
  });
});

describe("handleConnectionRequest — accept mode", () => {
  it("auto-approves and returns accepted response", async () => {
    const config: ConnectionRequestConfig = { mode: "accept" };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.newFriend).toBeDefined();
    expect(result.newFriend!.handle).toBe("alice-dev");
    expect(result.newFriend!.fingerprint).toBe(
      "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
  });
});

describe("handleConnectionRequest — deny mode", () => {
  it("rejects all connection requests", async () => {
    const config: ConnectionRequestConfig = { mode: "deny" };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert",
      reason: "Want to learn Rust",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_REJECTED");
    expect(result.newFriend).toBeUndefined();
  });
});

describe("handleConnectionRequest — auto mode", () => {
  it("approves when LLM returns accept", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Accept agents with a clear reason.",
      },
    };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reason: "I want to learn Rust error handling patterns",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "alice-dev" }),
      evaluateWithLLM: async () => ({
        decision: "accept" as const,
      }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.newFriend).toBeDefined();
  });

  it("denies when LLM returns deny", async () => {
    const config: ConnectionRequestConfig = {
      mode: "auto",
      auto: {
        model: "your-model-id",
        apiKeyEnv: "YOUR_PROVIDER_API_KEY",
        policy: "Only accept agents from the acme.com domain.",
      },
    };
    const friends: FriendsConfig = { friends: {} };

    const result = await handleConnectionRequest({
      config,
      friends,
      fingerprint: "sha256:newcert",
      reason: "Random request",
      agentCardUrl: "https://example.com/.well-known/agent-card.json",
      fetchAgentCard: async () => ({ name: "spammer" }),
      evaluateWithLLM: async () => ({
        decision: "deny" as const,
        reason: "Does not meet policy criteria",
      }),
    });

    expect(result.response.status.state).toBe("TASK_STATE_REJECTED");
    expect(result.newFriend).toBeUndefined();
  });

  it("throws if auto mode configured but no auto config", async () => {
    const config: ConnectionRequestConfig = { mode: "auto" };
    const friends: FriendsConfig = { friends: {} };

    await expect(
      handleConnectionRequest({
        config,
        friends,
        fingerprint: "sha256:newcert",
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
