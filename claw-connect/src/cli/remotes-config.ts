import fs from "fs";

export interface RemotesConfig {
  remotes: Record<string, never>;
}

export function writeRemotesConfig(filePath: string, _config: RemotesConfig): void {
  fs.writeFileSync(filePath, "[remotes]\n");
}
