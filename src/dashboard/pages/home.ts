import type { ConfigHolder } from "../../config-holder.js";
import { readPeerFingerprint } from "../../identity-paths.js";

export interface HomeContext {
  holder: ConfigHolder;
  configDir: string;
  startedAt: Date;
}

function truncateFingerprint(fp: string): string {
  const prefix = fp.slice(0, 15);
  return `${prefix}…`;
}

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function renderHomePage(ctx: HomeContext): string {
  const config = ctx.holder.server();
  const fingerprint = readPeerFingerprint(ctx.configDir);
  const agents = Object.entries(config.agents);

  const agentRows = agents.length === 0
    ? `<tr><td colspan="3" class="placeholder">No agents registered</td></tr>`
    : agents.map(([name, agent]) => `
        <tr>
          <td>${name}</td>
          <td>${agent.description || "—"}</td>
          <td>${agent.rateLimit}</td>
        </tr>`).join("");

  return `
    <h1>Home</h1>
    <dl class="info-grid">
      <dt>Fingerprint</dt>
      <dd><span class="fingerprint" data-full="${fingerprint}">${truncateFingerprint(fingerprint)}</span></dd>
      <dt>Public</dt>
      <dd>https://${config.server.host}:${config.server.port}</dd>
      <dt>Local</dt>
      <dd>http://127.0.0.1:${config.server.localPort}</dd>
      <dt>Uptime</dt>
      <dd>${formatUptime(ctx.startedAt)}</dd>
      <dt>Connection requests</dt>
      <dd>${config.connectionRequests.mode}</dd>
      <dt>Discovery</dt>
      <dd>${config.discovery.providers.join(", ")}</dd>
    </dl>

    <h2>Agents</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Description</th><th>Rate limit</th></tr>
      </thead>
      <tbody>
        ${agentRows}
      </tbody>
    </table>
  `;
}
