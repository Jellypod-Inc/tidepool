import fs from "fs";
import { loadServerConfig } from "./config.js";
import { loadPeersConfig } from "./peers/config.js";
import type { ServerConfig, PeersConfig } from "./types.js";

export interface ConfigHolder {
  server: () => ServerConfig;
  peers: () => PeersConfig;
  stop: () => void;
}

/**
 * Loads server.toml + peers.toml and watches both files for changes. Routes
 * consult the holder on every request via `server()` / `peers()`, so a newly
 * registered peer or agent is visible to the already-running daemon without a
 * restart.
 *
 * Uses fs.watchFile (polling) rather than fs.watch because tidepool lives
 * on developer laptops where the file is edited by our own CLI commands, not
 * large directory trees — polling is simpler and has fewer platform quirks
 * (fs.watch can fire zero, one, or multiple events per change depending on
 * the OS). Poll interval of 500ms keeps swap-agent latency tolerable.
 */
export function createConfigHolder(configDir: string): ConfigHolder {
  const serverPath = `${configDir}/server.toml`;
  const peersPath = `${configDir}/peers.toml`;

  let serverCfg = loadServerConfig(serverPath);
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
  fs.watchFile(peersPath, { interval: 500 }, onPeersChange);

  return {
    server: () => serverCfg,
    peers: () => peersCfg,
    stop: () => {
      fs.unwatchFile(serverPath, onServerChange);
      fs.unwatchFile(peersPath, onPeersChange);
    },
  };
}
