import fs from "fs";
import path from "path";
import {
  defaultServerConfig,
  writeServerConfig,
} from "../config-writer.js";
import { generateIdentity } from "../identity.js";
import { peerCertPath, peerKeyPath } from "../identity-paths.js";
import { writePeersConfig } from "../peers/config.js";

interface RunInitOpts {
  configDir: string;
}

export async function runInit(opts: RunInitOpts): Promise<void> {
  fs.mkdirSync(opts.configDir, { recursive: true });

  const serverPath = path.join(opts.configDir, "server.toml");
  if (!fs.existsSync(serverPath)) {
    writeServerConfig(serverPath, defaultServerConfig());
  }

  const peersPath = path.join(opts.configDir, "peers.toml");
  if (!fs.existsSync(peersPath)) {
    writePeersConfig(peersPath, { peers: {} });
  }

  const certPath = peerCertPath(opts.configDir);
  const keyPath = peerKeyPath(opts.configDir);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    await generateIdentity({ name: "peer", certPath, keyPath });
  }
}
