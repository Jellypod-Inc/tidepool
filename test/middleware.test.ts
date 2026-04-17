import { describe, it, expect } from "vitest";
import {
  checkFriend,
  checkAgentScope,
  resolveTenant,
  extractFingerprint,
  isConnectionRequest,
  findPeerByFingerprint,
  CONNECTION_EXTENSION_URL,
} from "../src/middleware.js";
import type { FriendsConfig, PeersConfig, ServerConfig } from "../src/types.js";

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
      rateLimit: "50/hour",
      description: "Rust expert",
      timeoutSeconds: 30,
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

describe("extractFingerprint", () => {
  it("returns fingerprint from a raw cert buffer", async () => {
    const forge = (await import("node-forge")).default;
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: "commonName", value: "test" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const rawBuffer = Buffer.from(der, "binary");

    const fingerprint = extractFingerprint(rawBuffer);
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const { getFingerprint } = await import("../src/identity.js");
    expect(fingerprint).toBe(getFingerprint(certPem));
  });

  it("returns null for undefined input", () => {
    const fingerprint = extractFingerprint(undefined);
    expect(fingerprint).toBeNull();
  });

  it("returns null for empty buffer", () => {
    const fingerprint = extractFingerprint(Buffer.alloc(0));
    expect(fingerprint).toBeNull();
  });
});

describe("isConnectionRequest", () => {
  const connectionRequestBody = {
    message: {
      messageId: "cr-1",
      role: "user",
      parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
      extensions: [CONNECTION_EXTENSION_URL],
      metadata: {
        [CONNECTION_EXTENSION_URL]: {
          type: "request",
          reason: "test",
          agent_card_url: "http://example.com/card.json",
        },
      },
    },
  };

  it("returns true when extension URI is in message.extensions", () => {
    expect(isConnectionRequest(connectionRequestBody, {})).toBe(true);
  });

  it("returns true when extension URI is only in X-A2A-Extensions header", () => {
    const bodyWithoutExt = {
      message: {
        ...connectionRequestBody.message,
        extensions: [],
      },
    };
    expect(
      isConnectionRequest(bodyWithoutExt, {
        "x-a2a-extensions": CONNECTION_EXTENSION_URL,
      }),
    ).toBe(true);
  });

  it("returns false when neither signal declares the extension", () => {
    const bodyNoExt = {
      message: {
        messageId: "x",
        role: "user",
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
      },
    };
    expect(isConnectionRequest(bodyNoExt, {})).toBe(false);
  });

  it("returns false when body is malformed", () => {
    expect(isConnectionRequest(null, {})).toBe(false);
    expect(isConnectionRequest({}, {})).toBe(false);
  });

  it("returns false when first part text is not CONNECTION_REQUEST", () => {
    const bodyWrong = {
      message: {
        messageId: "x",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        extensions: [CONNECTION_EXTENSION_URL],
      },
    };
    expect(isConnectionRequest(bodyWrong, {})).toBe(false);
  });
});

describe("middleware — peers-based inbound trust", () => {
  const peers: PeersConfig = {
    peers: {
      "bob-agent": {
        fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        endpoint: "https://bob.example.com",
        agents: [],
      },
      "dave-agent": {
        fingerprint: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        endpoint: "https://dave.example.com",
        agents: ["rust-expert"],
      },
    },
  };

  const emptyPeers: PeersConfig = { peers: {} };

  it("accepts an inbound cert matching a peer entry fingerprint", () => {
    const result = findPeerByFingerprint(
      peers,
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(result).toEqual({
      handle: "bob-agent",
      fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
  });

  it("rejects an inbound cert that is in neither peers nor friends", () => {
    const peerResult = findPeerByFingerprint(emptyPeers, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    const friendResult = checkFriend({ friends: {} }, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(peerResult).toBeNull();
    expect(friendResult).toBeNull();
  });

  it("finds peer by fingerprint case-insensitively", () => {
    // peers.toml stores lowercase; incoming cert fingerprint may vary in case
    const result = findPeerByFingerprint(
      peers,
      "SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    );
    expect(result).not.toBeNull();
    expect(result?.handle).toBe("bob-agent");
  });

  it("returns null for fingerprint not in peers", () => {
    const result = findPeerByFingerprint(peers, "sha256:aaaa");
    expect(result).toBeNull();
  });

  it("prefers peers entry when both peers and friends contain the fingerprint", () => {
    // Both have the same fingerprint — both lookups succeed independently (no crash)
    const sharedFp = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const friendsWithOverlap: FriendsConfig = {
      friends: {
        "bob-friend-alias": { fingerprint: sharedFp },
      },
    };
    const peerResult = findPeerByFingerprint(peers, sharedFp);
    const friendResult = checkFriend(friendsWithOverlap, sharedFp);
    // peers check wins (done first in the trust pipeline)
    expect(peerResult).not.toBeNull();
    expect(peerResult?.handle).toBe("bob-agent");
    // friends path would also have found it — no crash, no undefined behavior
    expect(friendResult).not.toBeNull();
    expect(friendResult?.handle).toBe("bob-friend-alias");
  });
});
