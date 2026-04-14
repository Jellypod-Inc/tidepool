import path from "path";
import { generateIdentity } from "../identity.js";
import { loadServerConfig } from "../config.js";
import { writeServerConfig, defaultServerConfig } from "../config-writer.js";
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
): Promise<{ fingerprint: string }> {
  const serverPath = path.join(opts.configDir, "server.toml");
  const cfg: ServerConfig = (() => {
    try {
      return loadServerConfig(serverPath);
    } catch {
      return defaultServerConfig();
    }
  })();

  if (cfg.agents[opts.name] && !opts.force) {
    throw new Error(
      `Agent "${opts.name}" is already registered. Use --force to overwrite.`,
    );
  }

  const certPath = path.join(
    opts.configDir,
    "agents",
    opts.name,
    "identity.crt",
  );
  const keyPath = path.join(
    opts.configDir,
    "agents",
    opts.name,
    "identity.key",
  );

  const identity = await generateIdentity({
    name: opts.name,
    certPath,
    keyPath,
  });

  cfg.agents[opts.name] = {
    localEndpoint: opts.localEndpoint,
    rateLimit: opts.rateLimit ?? "50/hour",
    description: opts.description ?? "",
    timeoutSeconds: opts.timeoutSeconds ?? 30,
  };

  writeServerConfig(serverPath, cfg);

  return { fingerprint: identity.fingerprint };
}
