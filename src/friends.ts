import fs from "fs";
import TOML from "@iarna/toml";
import type { FriendsConfig, FriendEntry } from "./types.js";

interface AddFriendOpts {
  handle: string;
  fingerprint: string;
  agents?: string[];
}

export function addFriend(
  config: FriendsConfig,
  opts: AddFriendOpts,
): FriendsConfig {
  if (config.friends[opts.handle]) {
    throw new Error(`Friend "${opts.handle}" already exists`);
  }

  // Check for duplicate fingerprint
  for (const [existingHandle, entry] of Object.entries(config.friends)) {
    if (entry.fingerprint === opts.fingerprint) {
      throw new Error(
        `Fingerprint already registered under handle "${existingHandle}"`,
      );
    }
  }

  const newEntry: FriendEntry = {
    fingerprint: opts.fingerprint,
  };
  if (opts.agents && opts.agents.length > 0) {
    newEntry.agents = opts.agents;
  }

  return {
    friends: {
      ...config.friends,
      [opts.handle]: newEntry,
    },
  };
}

export function removeFriend(
  config: FriendsConfig,
  handle: string,
): FriendsConfig {
  if (!config.friends[handle]) {
    throw new Error(`Friend "${handle}" not found`);
  }

  const { [handle]: _, ...rest } = config.friends;
  return { friends: rest };
}

interface FriendListEntry {
  handle: string;
  fingerprint: string;
  agents?: string[];
}

export function listFriends(config: FriendsConfig): FriendListEntry[] {
  return Object.entries(config.friends).map(([handle, entry]) => {
    const result: FriendListEntry = {
      handle,
      fingerprint: entry.fingerprint,
    };
    if (entry.agents) {
      result.agents = entry.agents;
    }
    return result;
  });
}

export function writeFriendsConfig(
  filePath: string,
  config: FriendsConfig,
): void {
  const tomlData: Record<string, unknown> = {
    friends: Object.fromEntries(
      Object.entries(config.friends).map(([handle, entry]) => {
        const value: Record<string, unknown> = {
          fingerprint: entry.fingerprint,
        };
        if (entry.agents) {
          value.agents = entry.agents;
        }
        return [handle, value];
      }),
    ),
  };

  fs.writeFileSync(filePath, TOML.stringify(tomlData as any));
}
