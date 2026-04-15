import path from "path";
import { loadServerConfig, loadFriendsConfig } from "../config.js";
import { buildStatusOutput } from "../status.js";
import { isServeRunning } from "./serve-daemon.js";

interface RunStatusOpts {
  configDir: string;
}

export async function runStatus(opts: RunStatusOpts): Promise<string> {
  const server = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const friends = loadFriendsConfig(path.join(opts.configDir, "friends.toml"));
  const base = buildStatusOutput(server, friends);

  const daemon = await isServeRunning({ configDir: opts.configDir });
  const daemonLine = daemon.running
    ? `Daemon: running (PID ${daemon.pid})`
    : `Daemon: not running`;

  return `${base}\n\n${daemonLine}`;
}
