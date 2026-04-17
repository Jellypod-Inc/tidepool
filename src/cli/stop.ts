import fs from "fs";
import path from "path";
import { PID_FILENAME } from "./serve-daemon.js";

export interface RunStopOpts {
  configDir: string;
  gracePeriodMs?: number;
}

export type RunStopResult =
  | { action: "not-running" }
  | { action: "stopped"; pid: number; forced: boolean };

export async function runStop(opts: RunStopOpts): Promise<RunStopResult> {
  const pidPath = path.join(opts.configDir, PID_FILENAME);
  if (!fs.existsSync(pidPath)) {
    return { action: "not-running" };
  }

  const raw = fs.readFileSync(pidPath, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0 || !isAlive(pid)) {
    fs.unlinkSync(pidPath);
    return { action: "not-running" };
  }

  process.kill(pid, "SIGTERM");
  const grace = opts.gracePeriodMs ?? 2000;
  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      fs.unlinkSync(pidPath);
      return { action: "stopped", pid, forced: false };
    }
    await sleep(50);
  }

  process.kill(pid, "SIGKILL");
  await sleep(50);
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  return { action: "stopped", pid, forced: true };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
