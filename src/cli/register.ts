import fs from "fs";
import path from "path";
import { loadServerConfig } from "../config.js";
import { writeServerConfig, defaultServerConfig } from "../config-writer.js";
import { readPeerFingerprint } from "../identity-paths.js";
import type { ServerConfig } from "../types.js";

interface RunRegisterOpts {
  configDir: string;
  name: string;
  localEndpoint: string;
  rateLimit?: string;
  description?: string;
  timeoutSeconds?: number;
  force?: boolean;
}

export async function runRegister(
  opts: RunRegisterOpts,
): Promise<{ peerFingerprint: string }> {
  // readPeerFingerprint throws a helpful "run init first" error if the peer
  // identity hasn't been generated yet. That's the only fatal precondition.
  const peerFingerprint = readPeerFingerprint(opts.configDir);

  const serverPath = path.join(opts.configDir, "server.toml");
  const cfg: ServerConfig = fs.existsSync(serverPath)
    ? loadServerConfig(serverPath)
    : defaultServerConfig();

  if (cfg.agents[opts.name] && !opts.force) {
    throw new Error(
      `Agent "${opts.name}" is already registered. Use --force to overwrite.`,
    );
  }

  cfg.agents[opts.name] = {
    localEndpoint: opts.localEndpoint,
    rateLimit: opts.rateLimit ?? "50/hour",
    description: opts.description ?? "",
    timeoutSeconds: opts.timeoutSeconds ?? 30,
  };

  writeServerConfig(serverPath, cfg);

  return { peerFingerprint };
}
