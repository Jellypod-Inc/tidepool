import type { ServerConfig, PeersConfig } from "./types.js";

export function buildStatusOutput(
  config: ServerConfig,
  peersCfg: PeersConfig,
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
      lines.push(`    Rate limit: ${agent.rateLimit}`);
      lines.push(`    Description: ${agent.description}`);
    }
  }

  const peers = Object.entries(peersCfg.peers);
  lines.push("");
  lines.push(`Peers (${peers.length})`);
  for (const [handle, entry] of peers) {
    lines.push(`  ${handle}  ${entry.endpoint}  (${entry.agents.length} agents)`);
    for (const a of entry.agents) lines.push(`    - ${a}`);
  }

  return lines.join("\n");
}
