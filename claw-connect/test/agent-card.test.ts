import { describe, it, expect } from "vitest";
import {
  buildLocalAgentCard,
  buildRemoteAgentCard,
} from "../src/agent-card.js";
import type { RemoteAgent } from "../src/types.js";

describe("buildLocalAgentCard", () => {
  it("builds an Agent Card for a locally registered agent", () => {
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
    expect(card.securitySchemes.mtls).toBeDefined();
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
