import path from "path";
import { loadFriendsConfig } from "../config.js";
import {
  addFriend,
  removeFriend,
  listFriends,
  writeFriendsConfig,
} from "../friends.js";

interface AddOpts {
  configDir: string;
  handle: string;
  fingerprint: string;
  agents?: string[];
}

interface RemoveOpts {
  configDir: string;
  handle: string;
}

interface ListOpts {
  configDir: string;
}

function friendsPath(dir: string): string {
  return path.join(dir, "friends.toml");
}

export async function runFriendAdd(opts: AddOpts): Promise<void> {
  const p = friendsPath(opts.configDir);
  const cfg = loadFriendsConfig(p);
  const next = addFriend(cfg, {
    handle: opts.handle,
    fingerprint: opts.fingerprint,
    agents: opts.agents,
  });
  writeFriendsConfig(p, next);
}

export async function runFriendRemove(opts: RemoveOpts): Promise<void> {
  const p = friendsPath(opts.configDir);
  const cfg = loadFriendsConfig(p);
  const next = removeFriend(cfg, opts.handle);
  writeFriendsConfig(p, next);
}

export async function runFriendList(
  opts: ListOpts,
): Promise<{ handle: string; fingerprint: string; agents?: string[] }[]> {
  const cfg = loadFriendsConfig(friendsPath(opts.configDir));
  return listFriends(cfg);
}
