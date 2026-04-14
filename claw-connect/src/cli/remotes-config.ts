import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { RemotesConfigSchema } from "../schemas.js";
import type { RemotesConfig } from "../types.js";

export function loadRemotesConfig(filePath: string): RemotesConfig {
  if (!fs.existsSync(filePath)) return { remotes: {} };
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(raw);
  const stripped = JSON.parse(JSON.stringify(parsed));
  return RemotesConfigSchema.parse(stripped) as RemotesConfig;
}

export function writeRemotesConfig(filePath: string, cfg: RemotesConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, TOML.stringify(cfg as unknown as TOML.JsonMap));
}
