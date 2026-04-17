import { describe, it, expect } from "vitest";
import {
  buildOutboundUrl,
  mapLocalTenantToRemote,
} from "../src/proxy.js";
import type { RemoteAgent } from "../src/types.js";

const remoteAgents: RemoteAgent[] = [
  {
    localHandle: "bobs-rust",
    remoteEndpoint: "https://bob.example.com:9900",
    remoteTenant: "rust-expert",
    certFingerprint: "sha256:aaaa",
  },
  {
    localHandle: "carols-ml",
    remoteEndpoint: "https://carol.example.com:9900",
    remoteTenant: "ml-agent",
    certFingerprint: "sha256:bbbb",
  },
];

describe("mapLocalTenantToRemote", () => {
  it("maps a local handle to a remote agent", () => {
    const result = mapLocalTenantToRemote(remoteAgents, "bobs-rust");
    expect(result).toEqual(remoteAgents[0]);
  });

  it("returns null for unknown local handle", () => {
    const result = mapLocalTenantToRemote(remoteAgents, "unknown");
    expect(result).toBeNull();
  });
});

describe("buildOutboundUrl", () => {
  it("constructs the remote A2A URL from endpoint and tenant", () => {
    const url = buildOutboundUrl(
      "https://bob.example.com:9900",
      "rust-expert",
      "/message:send",
    );
    expect(url).toBe(
      "https://bob.example.com:9900/rust-expert/message:send",
    );
  });
});
