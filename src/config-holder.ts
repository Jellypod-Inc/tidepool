import fs from "fs";
import { loadServerConfig, loadFriendsConfig } from "./config.js";
import { loadPeersConfig } from "./peers/config.js";
import type { ServerConfig, FriendsConfig, PeersConfig } from "./types.js";

export interface ConfigHolder {
  server: () => ServerConfig;
  friends: () => FriendsConfig;
  setFriends: (cfg: FriendsConfig) => void;
  peers: () => PeersConfig;
  stop: () => void;
}

/**
 * Loads server.toml + friends.toml and watches both files for changes. Routes
 * consult the holder on every request via `server()` / `friends()`, so a newly
 * registered agent is visible to the already-running daemon without a restart.
 *
 * Uses fs.watchFile (polling) rather than fs.watch because tidepool lives
 * on developer laptops where the file is edited by our own CLI commands, not
 * large directory trees — polling is simpler and has fewer platform quirks
 * (fs.watch can fire zero, one, or multiple events per change depending on
 * the OS). Poll interval of 500ms keeps swap-agent latency tolerable.
 */
export function createConfigHolder(configDir: string): ConfigHolder {
  const serverPath = `${configDir}/server.toml`;
  const friendsPath = `${configDir}/friends.toml`;
  const peersPath = `${configDir}/peers.toml`;

  let serverCfg = loadServerConfig(serverPath);
  let friendsCfg = loadFriendsConfig(friendsPath);
  let peersCfg = loadPeersConfig(peersPath);

  const onServerChange = () => {
    try {
      serverCfg = loadServerConfig(serverPath);
    } catch (err) {
      process.stderr.write(
        `[tidepool] reload of server.toml failed: ${String(err)} — keeping prior config\n`,
      );
    }
  };
  const onFriendsChange = () => {
    try {
      friendsCfg = loadFriendsConfig(friendsPath);
    } catch (err) {
      process.stderr.write(
        `[tidepool] reload of friends.toml failed: ${String(err)} — keeping prior config\n`,
      );
    }
  };
  const onPeersChange = () => {
    try {
      peersCfg = loadPeersConfig(peersPath);
    } catch (err) {
      process.stderr.write(
        `[tidepool] reload of peers.toml failed: ${String(err)} — keeping prior config\n`,
      );
    }
  };

  fs.watchFile(serverPath, { interval: 500 }, onServerChange);
  fs.watchFile(friendsPath, { interval: 500 }, onFriendsChange);
  fs.watchFile(peersPath, { interval: 500 }, onPeersChange);

  return {
    server: () => serverCfg,
    friends: () => friendsCfg,
    setFriends: (cfg: FriendsConfig) => { friendsCfg = cfg; },
    peers: () => peersCfg,
    stop: () => {
      fs.unwatchFile(serverPath, onServerChange);
      fs.unwatchFile(friendsPath, onFriendsChange);
      fs.unwatchFile(peersPath, onPeersChange);
    },
  };
}
