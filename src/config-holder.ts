import fs from "fs";
import { loadServerConfig, loadFriendsConfig } from "./config.js";
import type { ServerConfig, FriendsConfig } from "./types.js";

export interface ConfigHolder {
  server: () => ServerConfig;
  friends: () => FriendsConfig;
  setFriends: (cfg: FriendsConfig) => void;
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

  let serverCfg = loadServerConfig(serverPath);
  let friendsCfg = loadFriendsConfig(friendsPath);

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

  fs.watchFile(serverPath, { interval: 500 }, onServerChange);
  fs.watchFile(friendsPath, { interval: 500 }, onFriendsChange);

  return {
    server: () => serverCfg,
    friends: () => friendsCfg,
    setFriends: (cfg: FriendsConfig) => { friendsCfg = cfg; },
    stop: () => {
      fs.unwatchFile(serverPath, onServerChange);
      fs.unwatchFile(friendsPath, onFriendsChange);
    },
  };
}
