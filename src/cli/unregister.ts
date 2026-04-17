import fs from "fs";
import path from "path";
import { loadServerConfig } from "../config.js";
import { writeServerConfig } from "../config-writer.js";
import type { ServerConfig } from "../types.js";

interface RunUnregisterOpts {
  configDir: string;
  name: string;
}

export async function runUnregister(opts: RunUnregisterOpts): Promise<void> {
  const serverPath = path.join(opts.configDir, "server.toml");
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      `server.toml not found at ${serverPath}. Nothing to unregister.`,
    );
  }

  const cfg: ServerConfig = loadServerConfig(serverPath);
  if (!(opts.name in cfg.agents)) {
    const known = Object.keys(cfg.agents).join(", ") || "none";
    throw new Error(
      `Agent "${opts.name}" is not registered (have: ${known}).`,
    );
  }

  delete cfg.agents[opts.name];
  writeServerConfig(serverPath, cfg);
}
