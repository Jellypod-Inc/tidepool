import fs from "fs";
import path from "path";
import { loadServerConfig } from "../config.js";
import { getFingerprint } from "../identity.js";

interface RunWhoamiOpts {
  configDir: string;
}

export async function runWhoami(
  opts: RunWhoamiOpts,
): Promise<{ name: string; fingerprint: string }[]> {
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const out: { name: string; fingerprint: string }[] = [];
  for (const name of Object.keys(cfg.agents)) {
    const certPath = path.join(opts.configDir, "agents", name, "identity.crt");
    if (!fs.existsSync(certPath)) continue;
    const pem = fs.readFileSync(certPath, "utf-8");
    out.push({ name, fingerprint: getFingerprint(pem) });
  }
  return out;
}
