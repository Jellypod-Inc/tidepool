import path from "path";
import { loadServerConfig, loadFriendsConfig } from "../config.js";
import { buildStatusOutput } from "../status.js";
import { isServeRunning } from "./serve-daemon.js";

interface RunStatusOpts {
  configDir: string;
  /** Test seam — override the port isServeRunning probes. */
  localPortOverride?: number;
}

export async function runStatus(opts: RunStatusOpts): Promise<string> {
  const server = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const friends = loadFriendsConfig(path.join(opts.configDir, "friends.toml"));
  const base = buildStatusOutput(server, friends);

  const daemon = await isServeRunning({
    configDir: opts.configDir,
    localPortOverride: opts.localPortOverride,
  });
  const daemonBlock = daemon.running
    ? `Daemon: running`
    : [
        `Daemon: not running`,
        `  → run 'tidepool claude-code:start' in a project dir to start it,`,
        `    or 'tidepool start &' in any terminal to just bring up the daemon.`,
      ].join("\n");

  return `${base}\n\n${daemonBlock}`;
}
