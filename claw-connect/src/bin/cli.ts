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

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
