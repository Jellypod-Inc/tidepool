import { describe, it, expect } from "vitest";
import {
  checkFriend,
  checkAgentScope,
  resolveTenant,
  extractFingerprint,
  isConnectionRequest,
  CONNECTION_EXTENSION_URL,
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
