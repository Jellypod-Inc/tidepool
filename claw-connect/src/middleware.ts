import type {
  FriendsConfig,
  FriendEntry,
  ServerConfig,
  AgentConfig,
} from "./types.js";

interface FriendLookup {
  handle: string;
  friend: FriendEntry;
}

export function checkFriend(
  friends: FriendsConfig,
  fingerprint: string,
): FriendLookup | null {
  for (const [handle, entry] of Object.entries(friends.friends)) {
    if (entry.fingerprint === fingerprint) {
      return { handle, friend: entry };
    }
  }
  return null;
}

export function checkAgentScope(friend: FriendEntry, tenant: string): boolean {
  if (!friend.agents) return true; // unscoped = all agents
  return friend.agents.includes(tenant);
}

export function resolveTenant(
  config: ServerConfig,
  tenant: string,
): AgentConfig | null {
  return config.agents[tenant] ?? null;
}
