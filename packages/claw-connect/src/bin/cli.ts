#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "../cli/init.js";
import { runRegister } from "../cli/register.js";
import {
  runFriendAdd,
  runFriendList,
  runFriendRemove,
} from "../cli/friend.js";
import {
  runRemoteAdd,
  runRemoteList,
  runRemoteRemove,
} from "../cli/remote.js";
import { runWhoami } from "../cli/whoami.js";
import { runStatus } from "../cli/status.js";
import { runPing } from "../cli/ping.js";
import { runServe } from "../cli/serve.js";
import { runDirectoryServe } from "../cli/directory.js";
import { resolveConfigDir } from "../cli/paths.js";
import { ok } from "../cli/output.js";

const program = new Command();

program
  .name("claw-connect")
  .description("Local-first A2A peer server")
  .version("0.0.1")
  .option("-c, --config-dir <path>", "Override config directory")
  .option("-v, --verbose", "Verbose output");

program.addHelpText(
  "after",
  `\nExamples:\n` +
    `  $ claw-connect init\n` +
    `  $ claw-connect register alice-dev --local-endpoint http://127.0.0.1:28800\n` +
    `  $ claw-connect whoami\n` +
    `  $ claw-connect friend add bob sha256:...\n` +
    `  $ claw-connect remote add bobs-rust https://peer:29900 rust-expert sha256:...\n` +
    `  $ claw-connect serve\n`,
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
    ok(`Registered agent "${name}"`);
    ok(`  peer fingerprint: ${result.peerFingerprint}`);
  });

const friend = program.command("friend").description("Manage friends");

friend
  .command("add <handle> <fingerprint>")
  .description("Register a friend by handle and cert fingerprint")
  .option(
    "-s, --scope <agents...>",
    "Restrict visibility to specific local agents",
  )
  .action(async (handle: string, fingerprint: string, cmdOpts) => {
    const configDir = resolveConfigDir(program.opts());
    await runFriendAdd({
      configDir,
      handle,
      fingerprint,
      agents: cmdOpts.scope,
    });
    ok(`Added friend ${handle}`);
  });

friend
  .command("list")
  .description("List known friends")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const entries = await runFriendList({ configDir });
    if (entries.length === 0) {
      ok("(no friends)");
      return;
    }
    for (const e of entries) {
      const scope = e.agents ? ` [scoped: ${e.agents.join(", ")}]` : "";
      ok(`${e.handle}  ${e.fingerprint}${scope}`);
    }
  });

friend
  .command("remove <handle>")
  .description("Remove a friend")
  .action(async (handle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runFriendRemove({ configDir, handle });
    ok(`Removed friend ${handle}`);
  });

const remote = program.command("remote").description("Manage remote peers");

remote
  .command("add <localHandle> <remoteEndpoint> <remoteTenant> <certFingerprint>")
  .description("Register a remote peer to proxy")
  .action(async (localHandle, remoteEndpoint, remoteTenant, certFingerprint) => {
    const configDir = resolveConfigDir(program.opts());
    await runRemoteAdd({ configDir, localHandle, remoteEndpoint, remoteTenant, certFingerprint });
    ok(`Added remote ${localHandle} → ${remoteEndpoint}/${remoteTenant}`);
  });

remote
  .command("list")
  .description("List registered remote peers")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const entries = await runRemoteList({ configDir });
    if (entries.length === 0) {
      ok("(no remotes)");
      return;
    }
    for (const e of entries) {
      ok(`${e.localHandle}  →  ${e.remoteEndpoint}/${e.remoteTenant}  [${e.certFingerprint.slice(0, 20)}…]`);
    }
  });

remote
  .command("remove <localHandle>")
  .description("Remove a remote peer")
  .action(async (localHandle: string) => {
    const configDir = resolveConfigDir(program.opts());
    await runRemoteRemove({ configDir, localHandle });
    ok(`Removed remote ${localHandle}`);
  });

program
  .command("whoami")
  .description("Print local identities and their fingerprints")
  .action(async () => {
    const configDir = resolveConfigDir(program.opts());
    const { peerFingerprint, agents } = await runWhoami({ configDir });
    ok(`peer fingerprint: ${peerFingerprint}`);
    if (agents.length === 0) {
      ok("(no local agents — run 'claw-connect register <name>')");
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
  .command("serve")
  .alias("start")
  .description("Boot the Claw Connect server")
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
