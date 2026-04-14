import { Command } from "commander";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import TOML from "@iarna/toml";
import { Agent as UndiciAgent } from "undici";
import { generateIdentity } from "../src/identity.js";
import { buildLocalAgentCard } from "../src/agent-card.js";
import { startServer } from "../src/server.js";
import { loadFriendsConfig, loadServerConfig } from "../src/config.js";
import { addFriend, removeFriend, listFriends, writeFriendsConfig } from "../src/friends.js";
import { getFingerprint } from "../src/identity.js";
import { StaticProvider } from "../src/discovery/static-provider.js";
import { MdnsProvider } from "../src/discovery/mdns-provider.js";
import { DirectoryProvider } from "../src/discovery/directory-provider.js";
import { DiscoveryRegistry } from "../src/discovery/registry.js";
import type { DiscoveryProvider } from "../src/discovery/types.js";
import { buildStatusOutput } from "../src/status.js";
import { pingAgent, formatPingResult } from "../src/ping.js";

const DEFAULT_CONFIG_DIR = path.join(
  process.env.HOME ?? "~",
  ".claw-connect",
);

const program = new Command();

program
  .name("claw-connect")
  .description("Transparent A2A proxy with identity and trust")
  .version("0.0.1");

program
  .command("init")
  .description("Create config directory and default server.toml")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (opts) => {
    const configDir = opts.dir;

    if (fs.existsSync(path.join(configDir, "server.toml"))) {
      console.log(`Already initialized at ${configDir}`);
      return;
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });

    const defaultConfig = {
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
      },
      agents: {},
      connectionRequests: {
        mode: "deny",
      },
      discovery: {
        providers: ["static"],
        cacheTtlSeconds: 300,
      },
    };

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify(defaultConfig as any),
    );

    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    console.log(`Initialized Claw Connect at ${configDir}`);
    console.log(`  server.toml created`);
    console.log(`  friends.toml created`);
    console.log(`\nNext: claw-connect register --name <agent-name> --description "<desc>" --endpoint <url>`);
  });

program
  .command("register")
  .description("Register a new agent (generates cert, creates Agent Card)")
  .requiredOption("--name <name>", "Agent name")
  .requiredOption("--description <desc>", "Agent description")
  .requiredOption("--endpoint <url>", "Agent's local A2A endpoint")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (opts) => {
    const configDir = opts.dir;
    const agentDir = path.join(configDir, "agents", opts.name);

    if (fs.existsSync(agentDir)) {
      console.error(`Agent "${opts.name}" already registered at ${agentDir}`);
      process.exit(1);
    }

    fs.mkdirSync(agentDir, { recursive: true });

    // 1. Generate cert
    const identity = await generateIdentity({
      name: opts.name,
      certPath: path.join(agentDir, "identity.crt"),
      keyPath: path.join(agentDir, "identity.key"),
    });

    console.log(`Generated identity for "${opts.name}"`);
    console.log(`  Fingerprint: ${identity.fingerprint}`);

    // 2. Create Agent Card
    const card = buildLocalAgentCard({
      name: opts.name,
      description: opts.description,
      publicUrl: `https://localhost:9900`,
      tenant: opts.name,
    });

    fs.writeFileSync(
      path.join(agentDir, "agent-card.json"),
      JSON.stringify(card, null, 2),
    );

    // 3. Add to server.toml
    const serverTomlPath = path.join(configDir, "server.toml");
    const content = fs.readFileSync(serverTomlPath, "utf-8");
    const config = TOML.parse(content);

    if (!config.agents) config.agents = {};
    (config.agents as Record<string, unknown>)[opts.name] = {
      localEndpoint: opts.endpoint,
      rateLimit: "50/hour",
      description: opts.description,
      timeoutSeconds: 30,
    };

    fs.writeFileSync(serverTomlPath, TOML.stringify(config as any));

    console.log(`Registered agent "${opts.name}" → ${opts.endpoint}`);
    console.log(`  Agent Card: ${path.join(agentDir, "agent-card.json")}`);
    console.log(`  Added to server.toml`);
  });

program
  .command("agents")
  .description("List registered agents")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const serverTomlPath = path.join(opts.dir, "server.toml");
    if (!fs.existsSync(serverTomlPath)) {
      console.error("Not initialized. Run 'claw-connect init' first.");
      process.exit(1);
    }

    const content = fs.readFileSync(serverTomlPath, "utf-8");
    const config = TOML.parse(content);
    const agents = (config.agents ?? {}) as Record<string, Record<string, string>>;

    if (Object.keys(agents).length === 0) {
      console.log("No agents registered.");
      return;
    }

    for (const [name, cfg] of Object.entries(agents)) {
      console.log(`  ${name} → ${cfg.localEndpoint} (${cfg.description})`);
    }
  });

const friendsCmd = program
  .command("friends")
  .description("Manage friends list");

friendsCmd
  .command("list")
  .description("List all friends")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);
    const friends = listFriends(config);

    if (friends.length === 0) {
      console.log("No friends yet.");
      return;
    }

    for (const f of friends) {
      const scope = f.agents ? ` (agents: ${f.agents.join(", ")})` : " (all agents)";
      console.log(`  ${f.handle} — ${f.fingerprint}${scope}`);
    }
  });

friendsCmd
  .command("add")
  .description("Add a friend manually")
  .requiredOption("--handle <handle>", "Local handle for the friend")
  .requiredOption("--fingerprint <fingerprint>", "Friend's cert fingerprint (sha256:...)")
  .option("--agents <agents...>", "Scope to specific agents")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);

    try {
      const updated = addFriend(config, {
        handle: opts.handle,
        fingerprint: opts.fingerprint,
        agents: opts.agents,
      });

      writeFriendsConfig(friendsPath, updated);
      const scope = opts.agents ? ` (agents: ${opts.agents.join(", ")})` : " (all agents)";
      console.log(`Added friend "${opts.handle}" — ${opts.fingerprint}${scope}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to add friend");
      process.exit(1);
    }
  });

friendsCmd
  .command("remove")
  .description("Remove a friend")
  .argument("<handle>", "Handle of the friend to remove")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((handle, opts) => {
    const friendsPath = path.join(opts.dir, "friends.toml");
    const config = loadFriendsConfig(friendsPath);

    try {
      const updated = removeFriend(config, handle);
      writeFriendsConfig(friendsPath, updated);
      console.log(`Removed friend "${handle}"`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to remove friend");
      process.exit(1);
    }
  });

program
  .command("connect")
  .description("Send a connection request to a remote agent")
  .argument("<agent-card-url>", "URL of the remote agent's Agent Card")
  .requiredOption("--as <agent>", "Which local agent identity to use for the request")
  .option("--reason <reason>", "Reason for connecting", "Would like to connect")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (agentCardUrl, opts) => {
    const configDir = opts.dir;
    const agentName = opts.as;
    const reason = opts.reason;

    const certPath = path.join(configDir, "agents", agentName, "identity.crt");
    const keyPath = path.join(configDir, "agents", agentName, "identity.key");

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`Agent "${agentName}" not found. Run 'claw-connect register' first.`);
      process.exit(1);
    }

    console.log(`Fetching agent card from ${agentCardUrl}...`);
    let remoteCard: { name: string; url: string };
    try {
      const cardResp = await fetch(agentCardUrl);
      remoteCard = (await cardResp.json()) as { name: string; url: string };
    } catch (err) {
      console.error(`Failed to fetch agent card: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    console.log(`Remote agent: ${remoteCard.name} at ${remoteCard.url}`);

    const messageUrl = `${remoteCard.url}/message:send`;
    const body = {
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "CONNECTION_REQUEST" }],
        extensions: ["https://clawconnect.dev/ext/connection/v1"],
        metadata: {
          "https://clawconnect.dev/ext/connection/v1": {
            type: "request",
            reason,
            agent_card_url: agentCardUrl,
          },
        },
      },
    };

    console.log(`Sending connection request to ${messageUrl}...`);

    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);

      const response = await fetch(messageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher: new UndiciAgent({
          connect: { cert, key, rejectUnauthorized: false },
        }),
      });

      const result = (await response.json()) as Record<string, unknown>;

      const status = result.status as { state: string } | undefined;
      if (status?.state === "completed") {
        console.log("Connection accepted!");
        console.log(`Remote agent "${remoteCard.name}" is now a friend on their server.`);
        console.log(`\nTo add them as a friend on YOUR server, run:`);
        console.log(
          `  claw-connect friends add --handle "${remoteCard.name}" --fingerprint <their-fingerprint>`,
        );
      } else if (status?.state === "rejected") {
        const artifacts = result.artifacts as Array<{
          metadata?: Record<string, Record<string, string>>;
        }>;
        const ext =
          artifacts?.[0]?.metadata?.["https://clawconnect.dev/ext/connection/v1"];
        const denyReason = ext?.reason ?? "No reason given";
        console.log(`Connection denied: ${denyReason}`);
      } else {
        console.log("Unexpected response:", JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(
        `Connection request failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command("requests")
  .description("View pending inbound connection requests (mode=deny only)")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const pendingPath = path.join(opts.dir, "pending-requests.json");

    if (!fs.existsSync(pendingPath)) {
      console.log("No pending connection requests.");
      return;
    }

    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as {
      requests: Array<{
        fingerprint: string;
        reason: string;
        agentCardUrl: string;
        receivedAt: string;
      }>;
    };

    if (pending.requests.length === 0) {
      console.log("No pending connection requests.");
      return;
    }

    console.log(`${pending.requests.length} pending request(s):\n`);
    for (const req of pending.requests) {
      console.log(`  Fingerprint: ${req.fingerprint}`);
      console.log(`  Reason:      ${req.reason}`);
      console.log(`  Agent Card:  ${req.agentCardUrl}`);
      console.log(`  Received:    ${req.receivedAt}`);
      console.log();
    }

    console.log("To approve, run:");
    console.log('  claw-connect friends add --handle "<name>" --fingerprint "<fingerprint>"');
  });

program
  .command("status")
  .description("Show server status, registered agents, friend count")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const configDir = opts.dir;
    const serverTomlPath = path.join(configDir, "server.toml");

    if (!fs.existsSync(serverTomlPath)) {
      console.error("Not initialized. Run 'claw-connect init' first.");
      process.exit(1);
    }

    const serverConfig = loadServerConfig(serverTomlPath);
    const friendsConfig = loadFriendsConfig(
      path.join(configDir, "friends.toml"),
    );

    console.log(buildStatusOutput(serverConfig, friendsConfig));
  });

program
  .command("ping <target>")
  .description(
    "Check if a remote agent is reachable (by handle or Agent Card URL)",
  )
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (target, opts) => {
    let agentCardUrl: string;

    if (target.startsWith("http://") || target.startsWith("https://")) {
      agentCardUrl = target;
    } else {
      const configDir = opts.dir;
      const serverTomlPath = path.join(configDir, "server.toml");

      if (!fs.existsSync(serverTomlPath)) {
        console.error("Not initialized. Run 'claw-connect init' first.");
        process.exit(1);
      }

      const serverConfig = loadServerConfig(serverTomlPath);
      const peer = serverConfig.discovery.static?.peers?.[target];

      if (peer?.agentCardUrl) {
        agentCardUrl = peer.agentCardUrl;
      } else {
        console.error(
          `Unknown handle "${target}". Use a full Agent Card URL or add the peer to static discovery config.`,
        );
        process.exit(1);
      }
    }

    console.log(`Pinging ${agentCardUrl} ...`);
    const result = await pingAgent(agentCardUrl);
    console.log(formatPingResult(agentCardUrl, result));

    if (!result.reachable) {
      process.exit(1);
    }
  });

program
  .command("start")
  .description("Start the Claw Connect server")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (opts) => {
    const configDir = opts.dir;
    process.env.CC_CONFIG_DIR = configDir;

    console.log("Starting Claw Connect...");
    await startServer({ configDir });
  });

program
  .command("search [query]")
  .description("Search for agents via discovery providers")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .option("--local", "mDNS only (local network)", false)
  .action(async (query: string | undefined, opts) => {
    const configDir = opts.dir;
    const serverTomlPath = path.join(configDir, "server.toml");

    if (!fs.existsSync(serverTomlPath)) {
      console.error("Not initialized. Run 'claw-connect init' first.");
      process.exit(1);
    }

    const config = loadServerConfig(serverTomlPath);

    const providers: DiscoveryProvider[] = [];

    if (opts.local) {
      const mdns = new MdnsProvider();
      providers.push(mdns);
      console.log("Searching local network (mDNS)...\n");
    } else {
      if (config.discovery.static?.peers) {
        providers.push(new StaticProvider(config.discovery.static.peers));
      }

      if (config.discovery.mdns?.enabled) {
        providers.push(new MdnsProvider());
      }

      if (config.discovery.directory?.enabled && config.discovery.directory.url) {
        const agentNames = Object.keys(config.agents);
        if (agentNames.length === 0) {
          console.error(
            "Directory discovery is enabled but no agents are registered. Register an agent first.",
          );
          process.exit(1);
        }
        const certPath = path.join(configDir, "agents", agentNames[0], "identity.crt");
        if (!fs.existsSync(certPath)) {
          console.error(`Missing cert for agent "${agentNames[0]}" at ${certPath}.`);
          process.exit(1);
        }
        const certPem = fs.readFileSync(certPath, "utf-8");
        const fingerprint = getFingerprint(certPem);
        providers.push(new DirectoryProvider(config.discovery.directory.url, fingerprint));
      }

      const providerNames = providers.map((p) => p.name).join(", ");
      console.log(`Searching via: ${providerNames}...\n`);
    }

    if (providers.length === 0) {
      console.log("No discovery providers configured. Add providers to server.toml [discovery] section.");
      process.exit(0);
    }

    const registry = new DiscoveryRegistry(providers, config.discovery.cacheTtlSeconds);
    const results = await registry.search(query ? { query } : {});

    if (results.length === 0) {
      console.log("No agents found.");
    } else {
      console.log(`Found ${results.length} agent(s):\n`);
      for (const agent of results) {
        const statusIcon = agent.status === "online" ? "[online]" : "[offline]";
        console.log(`  ${agent.handle} ${statusIcon}`);
        console.log(`    ${agent.description}`);
        console.log(`    Endpoint: ${agent.endpoint}`);
        console.log(`    Agent Card: ${agent.agentCardUrl}`);
        console.log();
      }

      console.log("To connect to an agent:");
      console.log("  claw-connect connect <agent-card-url>");
    }

    for (const provider of providers) {
      if (provider instanceof MdnsProvider) {
        provider.destroy();
      }
    }
  });

program.parse();
