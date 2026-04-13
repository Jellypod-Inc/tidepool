import { Command } from "commander";
import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { buildLocalAgentCard } from "../src/agent-card.js";
import { startServer } from "../src/server.js";

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

program.parse();
