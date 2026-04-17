import { describe, it, expect } from "vitest";
import {
  parseScoped,
  projectHandles,
  resolveHandle,
} from "../../src/peers/resolve.js";
import type { PeersConfig } from "../../src/types.js";

describe("parseScoped", () => {
  it("returns bare handle when no slash", () => {
    expect(parseScoped("writer")).toEqual({ peer: null, agent: "writer" });
  });
  it("splits on slash", () => {
    expect(parseScoped("bob/writer")).toEqual({ peer: "bob", agent: "writer" });
  });
  it("rejects empty segments", () => {
    expect(() => parseScoped("/writer")).toThrow();
    expect(() => parseScoped("bob/")).toThrow();
    expect(() => parseScoped("")).toThrow();
  });
  it("rejects multiple slashes", () => {
    expect(() => parseScoped("a/b/c")).toThrow();
  });
});

describe("projectHandles", () => {
  const peers: PeersConfig = {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["writer", "rust-expert"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer", "trader"],
      },
    },
  };

  it("returns bare names when globally unique", () => {
    const names = projectHandles(peers, ["local-agent"]);
    expect(names).toContain("local-agent");
    expect(names).toContain("rust-expert");
    expect(names).toContain("trader");
  });

  it("returns scoped names for colliding agents", () => {
    const names = projectHandles(peers, ["local-agent"]);
    expect(names).toContain("alice/writer");
    expect(names).toContain("bob/writer");
    expect(names).not.toContain("writer");
  });

  it("local agent beats a remote with the same name → remote becomes scoped", () => {
    const names = projectHandles(peers, ["writer"]);
    expect(names).toContain("self/writer");
    expect(names).toContain("alice/writer");
    expect(names).toContain("bob/writer");
  });
});

describe("resolveHandle", () => {
  const peers: PeersConfig = {
    peers: {
      alice: {
        fingerprint: "sha256:" + "a".repeat(64),
        endpoint: "https://alice:9900",
        agents: ["rust-expert"],
      },
      bob: {
        fingerprint: "sha256:" + "b".repeat(64),
        endpoint: "https://bob:9900",
        agents: ["writer"],
      },
    },
  };

  it("resolves a scoped handle to its peer + agent", () => {
    expect(resolveHandle("bob/writer", peers, [])).toEqual({
      kind: "remote",
      peer: "bob",
      agent: "writer",
    });
  });

  it("resolves a bare unambiguous remote", () => {
    expect(resolveHandle("rust-expert", peers, [])).toEqual({
      kind: "remote",
      peer: "alice",
      agent: "rust-expert",
    });
  });

  it("resolves a bare local agent", () => {
    expect(resolveHandle("mine", peers, ["mine"])).toEqual({
      kind: "local",
      agent: "mine",
    });
  });

  it("errors on ambiguous bare handle", () => {
    const colliding: PeersConfig = {
      peers: {
        alice: {
          fingerprint: "sha256:" + "a".repeat(64),
          endpoint: "https://a:9900",
          agents: ["writer"],
        },
        bob: {
          fingerprint: "sha256:" + "b".repeat(64),
          endpoint: "https://b:9900",
          agents: ["writer"],
        },
      },
    };
    expect(() => resolveHandle("writer", colliding, [])).toThrow(/ambiguous/);
  });

  it("errors when handle not found", () => {
    expect(() => resolveHandle("nobody", peers, [])).toThrow(/no agent/);
  });

  it("errors when scoped peer is unknown", () => {
    expect(() => resolveHandle("carol/writer", peers, [])).toThrow(/unknown peer/);
  });

  it("errors when scoped agent is not in peer's agent list", () => {
    expect(() => resolveHandle("alice/trader", peers, [])).toThrow(/no agent .* on peer/);
  });
});
