#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { start } from "../start.js";

function defaultConfigDir(): string {
  if (process.env.CLAW_CONNECT_HOME) return process.env.CLAW_CONNECT_HOME;
  if (process.env.XDG_CONFIG_HOME)
    return path.join(process.env.XDG_CONFIG_HOME, "claw-connect");
  if (process.env.HOME)
    return path.join(process.env.HOME, ".config", "claw-connect");
  throw new Error(
    "could not resolve config dir: set --config-dir, CLAW_CONNECT_HOME, or HOME",
  );
}

const program = new Command();
program
  .name("a2a-claude-code-adapter")
  .description(
    "MCP channel server for Claude Code. Wires a session into the claw-connect network: receive inbound messages as channel events, list peers, and send messages on new or existing threads.",
  )
  .version("0.0.1")
  .option("-a, --agent <name>", "agent name in claw-connect's server.toml")
  .option(
    "-c, --config-dir <path>",
    "claw-connect config dir (default: $CLAW_CONNECT_HOME or $HOME/.config/claw-connect)",
  )
  .action(async (opts) => {
    const configDir = opts.configDir ?? defaultConfigDir();
    const handle = await start({
      configDir,
      agentName: opts.agent,
    });
    process.stderr.write(
      `[a2a-adapter] serving agent "${handle.agent.agentName}" on http://127.0.0.1:${handle.agent.port}\n`,
    );
    const shutdown = async (sig: string) => {
      process.stderr.write(`[a2a-adapter] ${sig} — shutting down\n`);
      await handle.close();
      process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
