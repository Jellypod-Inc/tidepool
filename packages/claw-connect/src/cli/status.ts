import path from "path";
import { loadServerConfig, loadFriendsConfig } from "../config.js";
import { buildStatusOutput } from "../status.js";

interface RunStatusOpts {
  configDir: string;
}

export async function runStatus(opts: RunStatusOpts): Promise<string> {
  const server = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const friends = loadFriendsConfig(path.join(opts.configDir, "friends.toml"));
  return buildStatusOutput(server, friends);
}
