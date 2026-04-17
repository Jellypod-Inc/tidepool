import { startServer } from "../server.js";

interface RunServeOpts {
  configDir: string;
}

export interface ServeHandle {
  stop: () => Promise<void>;
}

export async function runServe(opts: RunServeOpts): Promise<ServeHandle> {
  const server = await startServer({
    configDir: opts.configDir,
  });

  return {
    stop: async () => {
      server.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
