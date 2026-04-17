import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import TOML from "@iarna/toml";
import {
  addFriend,
  removeFriend,
  listFriends,
  writeFriendsConfig,
} from "../src/friends.js";
import type { FriendsConfig } from "../src/types.js";

describe("friends management", () => {
  let tmpDir: string;
  let friendsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-friends-"));
    friendsPath = path.join(tmpDir, "friends.toml");

    const initial: FriendsConfig = {
      friends: {
        "alice-agent": {
          fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    };
    fs.writeFileSync(friendsPath, TOML.stringify(initial as any));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe("addFriend", () => {
    it("adds a new friend to the config", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": {
            fingerprint: "sha256:aaaa",
          },
        },
      };

      const updated = addFriend(config, {
        handle: "bob-agent",
        fingerprint: "sha256:bbbb",
      });

      expect(updated.friends["bob-agent"]).toBeDefined();
      expect(updated.friends["bob-agent"].fingerprint).toBe("sha256:bbbb");
      expect(updated.friends["alice-agent"]).toBeDefined();
    });

    it("adds a scoped friend", () => {
      const config: FriendsConfig = { friends: {} };

      const updated = addFriend(config, {
        handle: "carol-ml",
        fingerprint: "sha256:cccc",
        agents: ["rust-expert"],
      });

      expect(updated.friends["carol-ml"].agents).toEqual(["rust-expert"]);
    });

    it("throws if handle already exists", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
        },
      };

      expect(() =>
        addFriend(config, {
          handle: "alice-agent",
          fingerprint: "sha256:different",
        }),
      ).toThrow("already exists");
    });

    it("throws if fingerprint already exists under different handle", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
        },
      };

      expect(() =>
        addFriend(config, {
          handle: "alice-duplicate",
          fingerprint: "sha256:aaaa",
        }),
      ).toThrow("already registered");
    });
  });

  describe("removeFriend", () => {
    it("removes a friend by handle", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
          "bob-agent": { fingerprint: "sha256:bbbb" },
        },
      };

      const updated = removeFriend(config, "alice-agent");

      expect(updated.friends["alice-agent"]).toBeUndefined();
      expect(updated.friends["bob-agent"]).toBeDefined();
    });

    it("throws if handle does not exist", () => {
      const config: FriendsConfig = { friends: {} };

      expect(() => removeFriend(config, "nobody")).toThrow("not found");
    });
  });

  describe("listFriends", () => {
    it("returns all friends as an array of entries", () => {
      const config: FriendsConfig = {
        friends: {
          "alice-agent": { fingerprint: "sha256:aaaa" },
          "bob-agent": { fingerprint: "sha256:bbbb", agents: ["rust-expert"] },
        },
      };

      const list = listFriends(config);

      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        handle: "alice-agent",
        fingerprint: "sha256:aaaa",
      });
      expect(list[1]).toEqual({
        handle: "bob-agent",
        fingerprint: "sha256:bbbb",
        agents: ["rust-expert"],
      });
    });
  });

  describe("writeFriendsConfig", () => {
    it("writes friends config to disk as TOML", () => {
      const config: FriendsConfig = {
        friends: {
          "new-friend": { fingerprint: "sha256:1234" },
        },
      };

      writeFriendsConfig(friendsPath, config);

      const content = fs.readFileSync(friendsPath, "utf-8");
      const parsed = TOML.parse(content);
      const friends = parsed.friends as Record<string, Record<string, unknown>>;
      expect(friends["new-friend"].fingerprint).toBe("sha256:1234");
    });

    it("roundtrips correctly with scoped agents", () => {
      const config: FriendsConfig = {
        friends: {
          "scoped-friend": {
            fingerprint: "sha256:5678",
            agents: ["rust-expert", "code-reviewer"],
          },
        },
      };

      writeFriendsConfig(friendsPath, config);

      const content = fs.readFileSync(friendsPath, "utf-8");
      const parsed = TOML.parse(content);
      const friends = parsed.friends as Record<string, Record<string, unknown>>;
      expect(friends["scoped-friend"].agents).toEqual([
        "rust-expert",
        "code-reviewer",
      ]);
    });
  });
});
