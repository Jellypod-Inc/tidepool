import net from "net";
import path from "path";
import { loadServerConfig } from "../config.js";

export interface RunStopOpts {
  configDir: string;
  gracePeriodMs?: number;
  /** Test seam — override localPort resolution. */
  localPortOverride?: number;
  /** Test seam — override HTTP shutdown attempt. */
  httpShutdown?: (url: string) => Promise<boolean>;
  /** Test seam — override port-free polling. */
  waitForPortFree?: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Test seam — override port liveness check. */
  isPortInUse?: (port: number) => Promise<boolean>;
}

export type RunStopResult =
  | { action: "not-running" }
  | { action: "stopped" }
  | { action: "unresponsive"; port: number };

export async function runStop(opts: RunStopOpts): Promise<RunStopResult> {
  const grace = opts.gracePeriodMs ?? 2000;
  const localPort = resolveLocalPort(opts);
  if (localPort === null) {
    return { action: "not-running" };
  }

  const portCheck = opts.isPortInUse ?? defaultIsPortInUse;
  if (!(await portCheck(localPort))) {
    return { action: "not-running" };
  }

  const url = `http://127.0.0.1:${localPort}/internal/shutdown`;
  const httpShutdown = opts.httpShutdown ?? defaultHttpShutdown;
  const waitForPortFree = opts.waitForPortFree ?? defaultWaitForPortFree;

  const accepted = await httpShutdown(url);
  if (accepted && (await waitForPortFree(localPort, grace))) {
    return { action: "stopped" };
  }

  // Port is in use but the daemon didn't respond to shutdown — likely wedged or
  // a different process is bound to the port. We don't guess at a PID; surface
  // it to the user so they can investigate with `lsof -iTCP:<port>`.
  return { action: "unresponsive", port: localPort };
}

function resolveLocalPort(opts: RunStopOpts): number | null {
  if (opts.localPortOverride !== undefined) return opts.localPortOverride;
  try {
    const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
    return cfg.server.localPort;
  } catch {
    return null;
  }
}

async function defaultHttpShutdown(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(500),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function defaultWaitForPortFree(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await defaultIsPortInUse(port))) return true;
    await sleep(50);
  }
  return false;
}

function defaultIsPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
