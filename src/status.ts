import type { ServerConfig, FriendsConfig } from "./types.js";

export function buildStatusOutput(
  config: ServerConfig,
  friends: FriendsConfig,
): string {
  const lines: string[] = [];

  lines.push("Tidepool Status");
  lines.push("=".repeat(40));

  lines.push("");
  lines.push("Server");
  lines.push(`  Public: https://${config.server.host}:${config.server.port}`);
  lines.push(`  Local: http://127.0.0.1:${config.server.localPort}`);
  lines.push(`  Rate limit: ${config.server.rateLimit}`);
  lines.push(`  Stream timeout: ${config.server.streamTimeoutSeconds}s`);
  lines.push(`  Connection requests: ${config.connectionRequests.mode}`);
  lines.push(`  Discovery: ${config.discovery.providers.join(", ")}`);

  lines.push("");
  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    lines.push("No agents registered");
  } else {
    lines.push(`Agents (${agentNames.length})`);
    for (const [name, agent] of Object.entries(config.agents)) {
      lines.push(`  ${name}`);
      lines.push(`    Endpoint: ${agent.localEndpoint}`);
      lines.push(`    Rate limit: ${agent.rateLimit}`);
      lines.push(`    Description: ${agent.description}`);
    }
  }

  lines.push("");
  const friendCount = Object.keys(friends.friends).length;
  lines.push(`${friendCount} friends`);

  if (friendCount > 0) {
    for (const [handle, entry] of Object.entries(friends.friends)) {
      const scope = entry.agents
        ? ` (scoped: ${entry.agents.join(", ")})`
        : " (all agents)";
      lines.push(`  ${handle}${scope}`);
    }
  }

  return lines.join("\n");
}
