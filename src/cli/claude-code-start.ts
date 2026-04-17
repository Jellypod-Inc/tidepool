// packages/tidepool/src/cli/claude-code-start.ts
import path from "path";
import fs from "fs";
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { runInit } from "./init.js";
import { runRegister } from "./register.js";
import { runUnregister } from "./unregister.js";
import { loadServerConfig, loadFriendsConfig } from "../config.js";
import { loadRemotesConfig } from "./remotes-config.js";
import { readPeerFingerprint } from "../identity-paths.js";
import { resolveAgentName } from "./name-resolver.js";
import { pickFreeLoopbackPort } from "./free-port.js";
import { ensureMcpJsonEntry } from "./mcp-json.js";
import { isServeRunning, spawnServeDaemon } from "./serve-daemon.js";
import type { ServerConfig } from "../types.js";

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

  // 4. write/merge .mcp.json, auto-prune the previous agent if the project swapped
  const mcp = await ensureMcpJsonEntry({ cwd: opts.cwd, agentName });
  if (
    mcp.action === "updated" &&
    mcp.previousAgent &&
    mcp.previousAgent !== agentName
  ) {
    try {
      await runUnregister({ configDir: opts.configDir, name: mcp.previousAgent });
      process.stdout.write(
        `\nnote: project was bound to "${mcp.previousAgent}" — swapped to "${agentName}" and removed "${mcp.previousAgent}" from server.toml.\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `\nnote: swapped project from "${mcp.previousAgent}" → "${agentName}". Could not remove "${mcp.previousAgent}" from server.toml: ${msg}\n`,
      );
    }
  }

  if (opts.debug) {
    // 5a. foreground serve — no daemon, no PID file, no auto-claude
    const runner = opts.debugServeRunner ?? defaultDebugServeRunner;
    process.stdout.write(
      `\nIn another terminal, run:\n  cd ${opts.cwd} && claude --dangerously-load-development-channels server:tidepool\n\n`,
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

  // 6. print launch summary so the user sees agent name, fingerprint, etc.
  const cfg3 = loadServerConfig(path.join(opts.configDir, "server.toml"));
  printLaunchSummary({
    configDir: opts.configDir,
    cwd: opts.cwd,
    agentName,
    serverConfig: cfg3,
  });

  // 7. exec claude (or print fallback if not on PATH)
  const onPath = (opts.claudeOnPath ?? defaultClaudeOnPath)();
  if (onPath) {
    const exec = opts.claudeExecutor ?? defaultClaudeExecutor;
    exec(
      "claude",
      ["--dangerously-load-development-channels", "server:tidepool"],
      { cwd: opts.cwd, stdio: "inherit" },
    );
  } else {
    process.stdout.write(
      `\nclaude is not on your PATH. Run this in a fresh terminal:\n  cd ${opts.cwd} && claude --dangerously-load-development-channels server:tidepool\n`,
    );
  }
}

function printLaunchSummary(args: {
  configDir: string;
  cwd: string;
  agentName: string;
  serverConfig: ServerConfig;
}): void {
  const { configDir, cwd, agentName, serverConfig } = args;

  let fingerprint = "(unavailable)";
  try {
    fingerprint = readPeerFingerprint(configDir);
  } catch {
    // identity not initialized yet — shouldn't happen after runInit, but don't crash
  }

  const agent = serverConfig.agents[agentName];
  const endpoint = agent?.localEndpoint ?? "(unknown)";

  let friendCount = 0;
  let remoteCount = 0;
  try {
    friendCount = Object.keys(
      loadFriendsConfig(path.join(configDir, "friends.toml")).friends,
    ).length;
  } catch {
    // ignore
  }
  try {
    remoteCount = Object.keys(
      loadRemotesConfig(path.join(configDir, "remotes.toml")).remotes,
    ).length;
  } catch {
    // ignore
  }

  const lines = [
    ``,
    `tidepool · launching Claude Code`,
    `  Agent:        ${agentName}`,
    `  Endpoint:     ${endpoint}`,
    `  Peer port:    ${serverConfig.server.port} (public mTLS) · ${serverConfig.server.localPort} (local proxy)`,
    `  Fingerprint:  ${fingerprint}`,
    `  Home:         ${configDir}`,
    `  Working dir:  ${cwd}`,
    `  Friends:      ${friendCount}   Remotes: ${remoteCount}`,
    ``,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function defaultDebugServeRunner(configDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn("tidepool", ["serve"], {
      stdio: "inherit",
      env: { ...process.env, TIDEPOOL_HOME: configDir },
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
