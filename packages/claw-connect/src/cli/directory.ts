import http from "http";
import { createDirectoryApp } from "../directory-server.js";

interface RunOpts {
  port: number;
  host?: string;
}

export interface DirectoryHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function runDirectoryServe(opts: RunOpts): Promise<DirectoryHandle> {
  const { app } = createDirectoryApp();
  const server = http.createServer(app);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const addr = server.address() as { port: number };
  return {
    port: addr.port,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
