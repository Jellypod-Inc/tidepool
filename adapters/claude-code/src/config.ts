import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";

export type AgentConfig = {
  agentName: string;
  /** If set, bind the inbound HTTP server to this port; otherwise pick an ephemeral one. */
  port?: number;
};

export type ProxyConfig = {
  localPort: number;
};

type ServerTomlAgentEntry = { localEndpoint?: unknown };
type ServerTomlServerBlock = { localPort?: unknown };
type ServerToml = {
  server?: ServerTomlServerBlock;
  agents?: Record<string, ServerTomlAgentEntry>;
};
type RemotesTomlEntry = Record<string, unknown>;
type RemotesToml = { remotes?: Record<string, RemotesTomlEntry> };

function readServerToml(configDir: string): ServerToml {
  const tomlPath = path.join(configDir, "server.toml");
  if (!fs.existsSync(tomlPath)) {
    throw new Error(`server.toml not found at ${tomlPath}`);
  }
  return TOML.parse(fs.readFileSync(tomlPath, "utf8")) as ServerToml;
}

export function loadAgentConfig(
  configDir: string,
  agentName?: string,
): AgentConfig {
  const parsed = readServerToml(configDir);
  const tomlPath = path.join(configDir, "server.toml");
  const agents = parsed.agents ?? {};
  const names = Object.keys(agents);

  let chosen: string;
  if (agentName) {
    if (!names.includes(agentName)) {
      throw new Error(
        `agent "${agentName}" not found in ${tomlPath} (have: ${names.join(", ") || "none"})`,
      );
    }
    chosen = agentName;
  } else if (names.length === 1) {
    chosen = names[0];
  } else if (names.length === 0) {
    throw new Error(`no agents defined in ${tomlPath}`);
  } else {
    throw new Error(
      `multiple agents in ${tomlPath} — specify one with --agent (have: ${names.join(", ")})`,
    );
  }

  const endpoint = agents[chosen].localEndpoint;
  if (endpoint === undefined) {
    return { agentName: chosen };
  }
  if (typeof endpoint !== "string") {
    throw new Error(`agents.${chosen}.localEndpoint must be a string URL`);
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `agents.${chosen}.localEndpoint is not a valid URL: ${endpoint}`,
    );
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `agents.${chosen}.localEndpoint must include an explicit port (got: ${endpoint})`,
    );
  }

  return { agentName: chosen, port };
}

export function loadProxyConfig(configDir: string): ProxyConfig {
  const parsed = readServerToml(configDir);
  const localPort = parsed.server?.localPort;
  if (typeof localPort !== "number" || !Number.isInteger(localPort) || localPort <= 0) {
    throw new Error(
      `server.localPort must be a positive integer in ${path.join(configDir, "server.toml")}`,
    );
  }
  return { localPort };
}

/**
 * Lists every handle this agent can talk to. Locality (local agent vs. remote
 * peer) is intentionally not surfaced — the agent treats all peers uniformly.
 * Excludes `self`.
 */
export function listPeerHandles(configDir: string, self: string): string[] {
  const server = readServerToml(configDir);
  const agents = Object.keys(server.agents ?? {});

  const remotesPath = path.join(configDir, "remotes.toml");
  let remotes: string[] = [];
  if (fs.existsSync(remotesPath)) {
    const parsed = TOML.parse(fs.readFileSync(remotesPath, "utf8")) as RemotesToml;
    remotes = Object.keys(parsed.remotes ?? {});
  }

  const all = new Set<string>([...agents, ...remotes]);
  all.delete(self);
  return [...all].sort();
}
