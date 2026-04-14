#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "../cli/init.js";
import { runRegister } from "../cli/register.js";
import { resolveConfigDir } from "../cli/paths.js";
import { ok } from "../cli/output.js";

const program = new Command();

program
  .name("claw-connect")
  .description("Local-first A2A peer server")
  .version("0.0.1")
  .option("-c, --config-dir <path>", "Override config directory")
  .option("-v, --verbose", "Verbose output");

program
  .command("init")
  .description("Create config files in the config directory")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    await runInit({ configDir });
    ok(`Initialized ${configDir}`);
  });

program
  .command("register <name>")
  .description("Generate an identity and register a local agent")
  .option(
    "-e, --local-endpoint <url>",
    "Where the local agent listens (e.g. http://127.0.0.1:28800)",
  )
  .option("--rate-limit <spec>", "Per-agent rate limit (default: 50/hour)")
  .option("--description <text>", "Human-readable description")
  .option(
    "--timeout <seconds>",
    "Per-agent timeout in seconds",
    (v) => parseInt(v, 10),
  )
  .option("-f, --force", "Overwrite existing identity + config")
  .action(async (name: string, cmdOpts) => {
    if (!cmdOpts.localEndpoint) {
      throw new Error("--local-endpoint is required");
    }
    const configDir = resolveConfigDir(program.opts());
    const result = await runRegister({
      configDir,
      name,
      localEndpoint: cmdOpts.localEndpoint,
      rateLimit: cmdOpts.rateLimit,
      description: cmdOpts.description,
      timeoutSeconds: cmdOpts.timeout,
      force: cmdOpts.force,
    });
    ok(`Registered ${name}`);
    ok(`  fingerprint: ${result.fingerprint}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
