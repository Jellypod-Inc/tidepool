import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { PeersConfigSchema } from "../schemas.js";
import type { PeersConfig } from "../types.js";

export function loadPeersConfig(filePath: string): PeersConfig {
  if (!fs.existsSync(filePath)) return { peers: {} };
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(raw);
  const stripped = JSON.parse(JSON.stringify(parsed));
  return PeersConfigSchema.parse(stripped);
}

export function writePeersConfig(filePath: string, cfg: PeersConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validated = PeersConfigSchema.parse(cfg);
  fs.writeFileSync(filePath, TOML.stringify(validated as unknown as TOML.JsonMap));
}
