import path from "path";
import { loadServerConfig } from "../config.js";
import { readPeerFingerprint } from "../identity-paths.js";

interface RunWhoamiOpts {
  configDir: string;
}

export async function runWhoami(
  opts: RunWhoamiOpts,
): Promise<{ peerFingerprint: string; agents: string[] }> {
  const peerFingerprint = readPeerFingerprint(opts.configDir);
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  return {
    peerFingerprint,
    agents: Object.keys(cfg.agents),
  };
}
