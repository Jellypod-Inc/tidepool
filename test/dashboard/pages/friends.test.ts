import { describe, it, expect } from "vitest";
import { renderFriendsTable } from "../../../src/dashboard/pages/friends.js";
import type { FriendsConfig } from "../../../src/types.js";

describe("renderFriendsTable", () => {
  it("renders an empty state when no friends", () => {
    const config: FriendsConfig = { friends: {} };
    const html = renderFriendsTable(config);
    expect(html).toContain("No friends");
  });

  it("renders a row per friend", () => {
    const config: FriendsConfig = {
      friends: {
        alice: { fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        bob: { fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agents: ["code-review"] },
      },
    };
    const html = renderFriendsTable(config);
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("code-review");
  });

  it("shows 'all agents' when no scope restriction", () => {
    const config: FriendsConfig = {
      friends: {
        alice: { fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
    };
    const html = renderFriendsTable(config);
    expect(html).toContain("all agents");
  });
});
