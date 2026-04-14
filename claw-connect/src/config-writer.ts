import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { loadServerConfig } from "./config.js";
import type { ServerConfig } from "./types.js";

export function writeServerConfig(filePath: string, cfg: ServerConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tomlStr = TOML.stringify(cfg as unknown as TOML.JsonMap);
  fs.writeFileSync(filePath, tomlStr);
}

export function defaultServerConfig(): ServerConfig {
  return {
    server: {
      port: 9900,
      host: "0.0.0.0",
      localPort: 9901,
      rateLimit: "100/hour",
      streamTimeoutSeconds: 300,
    },
    agents: {},
    connectionRequests: { mode: "deny" },
    discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    validation: { mode: "warn" },
  };
}

export function readOrInitServerConfig(filePath: string): ServerConfig {
  if (fs.existsSync(filePath)) return loadServerConfig(filePath);
  const cfg = defaultServerConfig();
  writeServerConfig(filePath, cfg);
  return cfg;
}
