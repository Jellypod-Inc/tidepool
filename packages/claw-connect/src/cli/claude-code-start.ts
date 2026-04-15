// packages/claw-connect/src/cli/claude-code-start.ts
import path from "path";
import fs from "fs";
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { runInit } from "./init.js";
import { runRegister } from "./register.js";
import { loadServerConfig } from "../config.js";
import { resolveAgentName } from "./name-resolver.js";
import { pickFreeLoopbackPort } from "./free-port.js";
import { ensureMcpJsonEntry } from "./mcp-json.js";
import { isServeRunning, spawnServeDaemon } from "./serve-daemon.js";

type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
type ClaudeExec = (
  cmd: string,
  args: string[],
  options: { cwd?: string; stdio?: "inherit" },
) => void;

export interface RunClaudeCodeStartOpts {
  configDir: string;
  cwd: string;
  explicitAgent?: string;
  debug: boolean;

  // DI (tests)
  localPortOverride?: number;
  spawner?: SpawnFn;
  readinessTimeoutMs?: number;
  claudeExecutor?: ClaudeExec;
  claudeOnPath?: () => boolean;
  rng?: () => string;
  debugServeRunner?: (configDir: string) => Promise<void>;
}

export async function runClaudeCodeStart(opts: RunClaudeCodeStartOpts): Promise<void> {
  // 1. init (idempotent — creates home and peer cert if missing)
  await runInit({ configDir: opts.configDir });

  // 2. resolve agent name (arg → .mcp.json → generated)
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const agentName = await resolveAgentName({
    cwd: opts.cwd,
    serverConfig: cfg,
    explicit: opts.explicitAgent,
    rng: opts.rng,
  });

  // 3. register if needed (re-read config in case name resolver didn't account for fresh write)
  const cfg2 = loadServerConfig(path.join(opts.configDir, "server.toml"));
  if (!(agentName in cfg2.agents)) {
    const port = await pickFreeLoopbackPort();
    await runRegister({
      configDir: opts.configDir,
      name: agentName,
      localEndpoint: `http://127.0.0.1:${port}`,
    });
  }

  // 4. write/merge .mcp.json
  await ensureMcpJsonEntry({ cwd: opts.cwd, agentName });

  if (opts.debug) {
    // 5a. foreground serve — no daemon, no PID file, no auto-claude
    const runner = opts.debugServeRunner ?? defaultDebugServeRunner;
    process.stdout.write(
      `\nIn another terminal, run:\n  cd ${opts.cwd} && claude --dangerously-load-development-channels server:a2a\n\n`,
    );
    await runner(opts.configDir);
    return;
  }

  // 5b. ensure daemon is running (probe first, spawn if not)
  const running = await isServeRunning({
    configDir: opts.configDir,
    localPortOverride: opts.localPortOverride,
  });
  if (!running.running) {
    await spawnServeDaemon({
      configDir: opts.configDir,
      spawner: opts.spawner,
      localPortOverride: opts.localPortOverride,
      readinessTimeoutMs: opts.readinessTimeoutMs,
    });
  }

  // 6. exec claude (or print fallback if not on PATH)
  const onPath = (opts.claudeOnPath ?? defaultClaudeOnPath)();
  if (onPath) {
    const exec = opts.claudeExecutor ?? defaultClaudeExecutor;
    exec(
      "claude",
      ["--dangerously-load-development-channels", "server:a2a"],
      { cwd: opts.cwd, stdio: "inherit" },
    );
  } else {
    process.stdout.write(
      `\nclaude is not on your PATH. Run this in a fresh terminal:\n  cd ${opts.cwd} && claude --dangerously-load-development-channels server:a2a\n`,
    );
  }
}

async function defaultDebugServeRunner(configDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn("claw-connect", ["serve"], {
      stdio: "inherit",
      env: { ...process.env, CLAW_CONNECT_HOME: configDir },
    });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

function defaultClaudeOnPath(): boolean {
  const PATH_ENV = process.env.PATH ?? "";
  for (const dir of PATH_ENV.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "claude"));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

const defaultClaudeExecutor: ClaudeExec = (cmd, args, options) => {
  const child = nodeSpawn(cmd, args, {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
  });
  // The CLI process waits for claude to exit so the terminal stays
  // attached. When claude exits, this promise-less chain naturally
  // returns control; since runClaudeCodeStart returns void after this
  // call, callers fall through to normal CLI exit.
  child.on("exit", () => {
    // no-op — the exec is fire-and-forget from the orchestrator's POV
  });
};
