import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";

export type AgentConfig = {
  agentName: string;
  port: number;
};

type ServerTomlAgentEntry = { localEndpoint?: unknown };
type ServerToml = { agents?: Record<string, ServerTomlAgentEntry> };

export function loadAgentConfig(
  configDir: string,
  agentName?: string,
): AgentConfig {
  const tomlPath = path.join(configDir, "server.toml");
  if (!fs.existsSync(tomlPath)) {
    throw new Error(`server.toml not found at ${tomlPath}`);
  }

  const raw = fs.readFileSync(tomlPath, "utf8");
  const parsed = TOML.parse(raw) as ServerToml;
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
