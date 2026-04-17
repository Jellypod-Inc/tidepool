import path from "path";
import { loadRemotesConfig, writeRemotesConfig } from "./remotes-config.js";
import { RemotesConfigSchema } from "../schemas.js";
import type { RemoteAgent } from "../types.js";

interface AddOpts extends RemoteAgent {
  configDir: string;
}

interface RemoveOpts {
  configDir: string;
  localHandle: string;
}

interface ListOpts {
  configDir: string;
}

function remotesPath(dir: string): string {
  return path.join(dir, "remotes.toml");
}

export async function runRemoteAdd(opts: AddOpts): Promise<void> {
  const p = remotesPath(opts.configDir);
  const cfg = loadRemotesConfig(p);
  if (cfg.remotes[opts.localHandle]) {
    throw new Error(`Remote "${opts.localHandle}" already exists`);
  }
  const { configDir: _configDir, ...entry } = opts;
  cfg.remotes[opts.localHandle] = entry;
  RemotesConfigSchema.parse(cfg);
  writeRemotesConfig(p, cfg);
}

export async function runRemoteRemove(opts: RemoveOpts): Promise<void> {
  const p = remotesPath(opts.configDir);
  const cfg = loadRemotesConfig(p);
  if (!cfg.remotes[opts.localHandle]) {
    throw new Error(`Remote "${opts.localHandle}" not found`);
  }
  delete cfg.remotes[opts.localHandle];
  writeRemotesConfig(p, cfg);
}

export async function runRemoteList(opts: ListOpts): Promise<RemoteAgent[]> {
  const cfg = loadRemotesConfig(remotesPath(opts.configDir));
  return Object.values(cfg.remotes);
}
