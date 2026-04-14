#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("claw-connect")
  .description("Local-first A2A peer server")
  .version("0.0.1")
  .option("-c, --config-dir <path>", "Override config directory")
  .option("-v, --verbose", "Verbose output");

// Subcommands registered here by later tasks.

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
