#!/usr/bin/env node
import { Command } from "commander";
import { start } from "../server.js";

const program = new Command();

program
  .name("a2a-claude-code-adapter")
  .description(
    "A2A endpoint that prints inbound messages to stdout and waits for replies via a control endpoint. Pair with Claude Code's Monitor tool.",
  )
  .version("0.0.1")
  .option("-p, --port <port>", "Listen port", (v) => parseInt(v, 10), 28800)
  .option("-h, --host <host>", "Bind host", "127.0.0.1")
  .option(
    "--reply-timeout <ms>",
    "Milliseconds to wait for a reply before failing the request",
    (v) => parseInt(v, 10),
    10 * 60_000,
  )
  .action((opts) => {
    const handle = start({
      port: opts.port,
      host: opts.host,
      replyTimeoutMs: opts.replyTimeout,
    });

    const shutdown = async (sig: string) => {
      process.stderr.write(`received ${sig}, shutting down\n`);
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
