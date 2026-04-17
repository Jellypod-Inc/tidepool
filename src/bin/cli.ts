#!/usr/bin/env node
import readline from "node:readline";
import path from "node:path";
import { Command } from "commander";
import { runInit } from "../cli/init.js";
import { runRegister } from "../cli/register.js";
import { runUnregister } from "../cli/unregister.js";
import {
  runAgentAdd,
  runAgentList,
  runAgentRemove,
  runAgentRefresh,
} from "../cli/agent.js";
import { runWhoami } from "../cli/whoami.js";
import { runStatus } from "../cli/status.js";
import { runPing } from "../cli/ping.js";
import { runServe } from "../cli/serve.js";
import { runDirectoryServe } from "../cli/directory.js";
import { runClaudeCodeStart } from "../cli/claude-code-start.js";
import { runStop } from "../cli/stop.js";
import { runTail } from "../cli/tail.js";
import { resolveConfigDir } from "../cli/paths.js";
import { ok } from "../cli/output.js";
import { loadServerConfig } from "../config.js";

const program = new Command();

program
  .name("tidepool")
  .description("Local-first A2A peer server")
  .version("0.0.1")
  .option("-c, --config-dir <path>", "Override config directory")
  .option("-v, --verbose", "Verbose output");

program.addHelpText(
  "after",
  `\nExamples:\n` +
    `  $ tidepool claude-code:start\n` +
    `  $ tidepool claude-code:start my-agent --debug\n` +
    `  $ tidepool stop\n` +
    `  $ tidepool init\n` +
    `  $ tidepool register alice-dev\n` +
    `  $ tidepool whoami\n` +
    `  $ tidepool agent add https://peer:29900 rust-expert --fingerprint sha256:...\n` +
    `  $ tidepool agent ls\n` +
    `  $ tidepool start\n`,
);

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
  .description("Register a local agent (endpoint declared at runtime via SSE session)")
  .option("--rate-limit <spec>", "Per-agent rate limit (default: 50/hour)")
  .option("--description <text>", "Human-readable description")
  .option(
    "--timeout <seconds>",
    "Per-agent timeout in seconds",
    (v) => parseInt(v, 10),
  )
  .option("-f, --force", "Overwrite existing identity + config")
  .action(async (name: string, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    const result = await runRegister({
      configDir,
      name,
      rateLimit: cmdOpts.rateLimit,
      description: cmdOpts.description,
      timeoutSeconds: cmdOpts.timeout,
      force: cmdOpts.force,
    });
    ok(`Registered agent "${name}"`);
    ok(`  peer fingerprint: ${result.peerFingerprint}`);
    ok("");
    ok(`"${name}" is reserved in server.toml but offline until an adapter claims it.`);
    ok("Bring it online by attaching an adapter:");
    ok(`  $ tidepool claude-code:start ${name}    # Claude Code (MCP)`);
    ok("An adapter opens an SSE session to the daemon and advertises where to deliver inbound messages.");
  });

program
  .command("unregister <name>")
  .description("Remove a local agent from server.toml")
  .action(async (name: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runUnregister({ configDir, name });
    ok(`Unregistered agent "${name}"`);
  });

const agent = program.command("agent").description("Manage remote agents");

agent
  .command("add <endpoint> <name>")
  .description("Add a remote peer's agent")
  .option("--fingerprint <sha256>", "Pin cert fingerprint (required until DIDs land)")
  .option("--alias <handle>", "Local peer handle if auto-derivation collides")
  .action(async (endpoint: string, name: string, cmdOpts: { fingerprint?: string; alias?: string }) => {
    const configDir = resolveConfigDir(program.opts());
    await runAgentAdd({
      configDir,
      endpoint,
      agent: name,
      fingerprint: cmdOpts.fingerprint,
      alias: cmdOpts.alias,
      confirm: async ({ fingerprint, endpoint: ep, agent: ag }) => {
        if (!process.stdin.isTTY) return true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((r) =>
          rl.question(`Add agent ${ag} at ${ep} (fingerprint ${fingerprint})? [y/N] `, r),
        );
        rl.close();
        return /^y/i.test(answer);
      },
    });
    ok(`added ${name}`);
  });

agent
  .command("ls")
  .description("List agents in local namespace")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const serverPath = path.join(configDir, "server.toml");
    const serverCfg = loadServerConfig(serverPath);
    const handles = await runAgentList({
      configDir,
      localAgents: Object.keys(serverCfg.agents),
    });
    for (const h of handles) process.stdout.write(h + "\n");
  });

agent
  .command("rm <handle>")
  .description("Remove a remote agent (scoped: peer/agent)")
  .action(async (handle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runAgentRemove({ configDir, handle });
    ok(`removed ${handle}`);
  });

agent
  .command("refresh <peer>")
  .description("Re-fetch a peer's agent card and merge advertised agents")
  .action(async (peer: string) => {
    const configDir = resolveConfigDir(program.opts());
    const { added, observedRemoved } = await runAgentRefresh({ configDir, peer });
    ok(`refreshed ${peer}: +[${added.join(", ")}] observed-removed=[${observedRemoved.join(", ")}]`);
  });

program
  .command("whoami")
  .description("Print local identities and their fingerprints")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const { peerFingerprint, agents } = await runWhoami({ configDir });
    ok(`peer fingerprint: ${peerFingerprint}`);
    if (agents.length === 0) {
      ok("(no local agents — run 'tidepool register <name>')");
      return;
    }
    ok(`agents: ${agents.join(", ")}`);
  });

program
  .command("status")
  .description("Show configured server + agents + friends")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const out = await runStatus({ configDir });
    ok(out);
  });

program
  .command("ping <url>")
  .description("Fetch an Agent Card and report reachability + metadata")
  .action(async (url: string) => {
    const out = await runPing({ url });
    ok(out);
  });

program
  .command("start")
  .description("Boot the Tidepool server")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const handle = await runServe({ configDir });
    const shutdown = async (signal: string) => {
      process.stderr.write(`\nReceived ${signal}, shutting down...\n`);
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

const directory = program.command("directory").description("Directory service");

directory
  .command("serve")
  .description("Run a standalone directory server")
  .option("-p, --port <port>", "Listen port", (v) => parseInt(v, 10), 9100)
  .option("-h, --host <host>", "Bind host", "127.0.0.1")
  .action(async (cmdOpts) => {
    const handle = await runDirectoryServe({
      port: cmdOpts.port,
      host: cmdOpts.host,
    });
    ok(`Directory listening on http://${cmdOpts.host}:${handle.port}`);
    const shutdown = async () => {
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("claude-code:start [agent]")
  .description("Start a Claude Code session wired up via A2A")
  .option("--debug", "Run tidepool start in the foreground; don't exec claude")
  .action(async (agent: string | undefined, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    await runClaudeCodeStart({
      configDir,
      cwd: process.cwd(),
      explicitAgent: agent,
      debug: !!cmdOpts.debug,
    });
  });

program
  .command("tail")
  .description("Stream inbound/outbound A2A messages crossing the daemon")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    await runTail({ configDir });
  });

program
  .command("stop")
  .description("Stop the background tidepool daemon")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const result = await runStop({ configDir });
    if (result.action === "not-running") {
      ok("Tidepool is not running.");
    } else if (result.action === "stopped") {
      ok("Stopped.");
    } else {
      process.stderr.write(
        `Daemon is bound to port ${result.port} but did not respond to /internal/shutdown.\n` +
          `Inspect with: lsof -iTCP:${result.port} -sTCP:LISTEN -P\n`,
      );
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
