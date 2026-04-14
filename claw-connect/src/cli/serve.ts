import path from "path";
import { startServer } from "../server.js";
import { loadRemotesConfig } from "./remotes-config.js";
import type { RemoteAgent } from "../types.js";

interface RunServeOpts {
  configDir: string;
}

export interface ServeHandle {
  stop: () => Promise<void>;
}

export async function runServe(opts: RunServeOpts): Promise<ServeHandle> {
  const remotesCfg = loadRemotesConfig(
    path.join(opts.configDir, "remotes.toml"),
  );
  const remoteAgents: RemoteAgent[] = Object.values(remotesCfg.remotes);

  const server = await startServer({
    configDir: opts.configDir,
    remoteAgents,
  });

  return {
    stop: async () => {
      server.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
