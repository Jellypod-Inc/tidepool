import path from "node:path";
import { loadPeersConfig, writePeersConfig } from "../peers/config.js";
import { fetchRemoteAgentCard } from "../agent-card.js";

export interface AgentAddOpts {
  configDir: string;
  endpoint: string;
  agent: string;
  fingerprint?: string;
  did?: string;
  alias?: string;
  confirm: (prompt: {
    endpoint: string;
    fingerprint: string;
    agent: string;
  }) => Promise<boolean>;
}

function peersPath(configDir: string): string {
  return path.join(configDir, "peers.toml");
}

function deriveFallbackHandle(fingerprint: string): string {
  return "peer-" + fingerprint.replace("sha256:", "").slice(0, 8);
}

function sanitizeHandle(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "");
}

export async function runAgentAdd(opts: AgentAddOpts): Promise<void> {
  if (!opts.fingerprint) {
    throw new Error("--fingerprint required (DID-based TOFU not yet implemented)");
  }

  const cardUrl = `${opts.endpoint.replace(/\/+$/, "")}/${opts.agent}/.well-known/agent-card.json`;
  const card = await fetchRemoteAgentCard(cardUrl);
  if (!card) throw new Error(`failed to fetch agent card at ${cardUrl}`);

  const ok = await opts.confirm({
    endpoint: opts.endpoint,
    fingerprint: opts.fingerprint,
    agent: opts.agent,
  });
  if (!ok) throw new Error("aborted by user");

  const cfg = loadPeersConfig(peersPath(opts.configDir));
  const target = opts.fingerprint.toLowerCase();

  // Existing peer by fingerprint: append agent
  for (const [, entry] of Object.entries(cfg.peers)) {
    if (entry.fingerprint?.toLowerCase() === target) {
      if (!entry.agents.includes(opts.agent)) entry.agents.push(opts.agent);
      writePeersConfig(peersPath(opts.configDir), cfg);
      return;
    }
  }

  // New peer
  const derived = sanitizeHandle(card.name || "") || deriveFallbackHandle(opts.fingerprint);
  const desired = opts.alias ?? derived;

  if (cfg.peers[desired]) {
    throw new Error(
      `peer handle "${desired}" already exists with a different fingerprint; pass --alias <new-handle>`,
    );
  }

  cfg.peers[desired] = {
    fingerprint: opts.fingerprint,
    endpoint: opts.endpoint,
    agents: [opts.agent],
    ...(opts.did ? { did: opts.did } : {}),
  };

  writePeersConfig(peersPath(opts.configDir), cfg);
}
