// packages/tidepool/src/cli/serve-daemon.ts
import fs from "fs";
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { loadServerConfig } from "../config.js";

export const LOGS_DIRNAME = "logs";

type SpawnFn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface IsServeRunningOpts {
  configDir: string;
  localPortOverride?: number;
  probe?: (url: string) => Promise<boolean>;
}

export type IsServeRunningResult =
  | { running: false; reason: "port-not-responding" | "no-config" }
  | { running: true };

export async function isServeRunning(
  opts: IsServeRunningOpts,
): Promise<IsServeRunningResult> {
  const localPort = resolveLocalPort(opts);
  if (localPort === null) {
    return { running: false, reason: "no-config" };
  }
  const url = `http://127.0.0.1:${localPort}/.well-known/agent-card.json`;
  const probe = opts.probe ?? defaultProbe;
  const reachable = await probe(url);
  if (!reachable) return { running: false, reason: "port-not-responding" };
  return { running: true };
}

export interface SpawnServeDaemonOpts {
  configDir: string;
  localPortOverride?: number;
  readinessTimeoutMs?: number;
  spawner?: SpawnFn;
  probe?: (url: string) => Promise<boolean>;
  now?: () => Date;
}

export async function spawnServeDaemon(opts: SpawnServeDaemonOpts): Promise<{ pid: number; logPath: string }> {
  const logsDir = path.join(opts.configDir, LOGS_DIRNAME);
  fs.mkdirSync(logsDir, { recursive: true });

  const date = (opts.now ?? (() => new Date()))();
  const ymd = toYmdUtc(date);
  const logPath = path.join(logsDir, `serve-${ymd}.log`);
  const logFd = fs.openSync(logPath, "a");

  const spawner = opts.spawner ?? nodeSpawn;
  const child = spawner("tidepool", ["serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, TIDEPOOL_HOME: opts.configDir },
  });
  fs.closeSync(logFd);

  if (child.pid === undefined) {
    throw new Error("spawn returned no PID");
  }

  child.unref();

  const localPort = resolveLocalPort(opts);
  if (localPort === null) {
    throw new Error("Cannot spawn daemon: missing server.toml (run 'tidepool init' first).");
  }
  const url = `http://127.0.0.1:${localPort}/.well-known/agent-card.json`;
  const probe = opts.probe ?? defaultProbe;
  const timeoutMs = opts.readinessTimeoutMs ?? 3000;

  const ready = await waitForReady(url, timeoutMs, probe);
  if (!ready) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    throw new Error(
      `Tidepool did not become ready within ${timeoutMs}ms. Check logs at ${logPath}, or rerun with --debug to see output.`,
    );
  }

  return { pid: child.pid, logPath };
}

function resolveLocalPort(opts: { configDir: string; localPortOverride?: number }): number | null {
  if (opts.localPortOverride !== undefined) return opts.localPortOverride;
  try {
    const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
    return cfg.server.localPort;
  } catch {
    return null;
  }
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  probe: (url: string) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function toYmdUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
