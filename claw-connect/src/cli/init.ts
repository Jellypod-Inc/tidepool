import fs from "fs";
import path from "path";
import {
  defaultServerConfig,
  writeServerConfig,
} from "../config-writer.js";
import { writeFriendsConfig } from "../friends.js";
import { writeRemotesConfig } from "./remotes-config.js";

interface RunInitOpts {
  configDir: string;
}

export async function runInit(opts: RunInitOpts): Promise<void> {
  fs.mkdirSync(opts.configDir, { recursive: true });

  const serverPath = path.join(opts.configDir, "server.toml");
  if (!fs.existsSync(serverPath)) {
    writeServerConfig(serverPath, defaultServerConfig());
  }

  const friendsPath = path.join(opts.configDir, "friends.toml");
  if (!fs.existsSync(friendsPath)) {
    writeFriendsConfig(friendsPath, { friends: {} });
  }

  const remotesPath = path.join(opts.configDir, "remotes.toml");
  if (!fs.existsSync(remotesPath)) {
    writeRemotesConfig(remotesPath, { remotes: {} });
  }
}
