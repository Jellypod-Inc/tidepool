import type { PeersConfig } from "../types.js";

export type Scoped = { peer: string | null; agent: string };

export type ResolvedHandle =
  | { kind: "local"; agent: string }
  | { kind: "remote"; peer: string; agent: string };

export function parseScoped(handle: string): Scoped {
  if (!handle) throw new Error("empty handle");
  const parts = handle.split("/");
  if (parts.length === 1) {
    return { peer: null, agent: parts[0] };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid scoped handle: ${handle}`);
  }
  return { peer: parts[0], agent: parts[1] };
}

export function projectHandles(peers: PeersConfig, localAgents: string[]): string[] {
  const counts = new Map<string, number>();
  for (const a of localAgents) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const peer of Object.values(peers.peers)) {
    for (const a of peer.agents) counts.set(a, (counts.get(a) ?? 0) + 1);
  }

  const out: string[] = [];
  for (const a of localAgents) {
    out.push((counts.get(a) ?? 0) > 1 ? `self/${a}` : a);
  }
  for (const [peerName, peer] of Object.entries(peers.peers)) {
    for (const a of peer.agents) {
      out.push((counts.get(a) ?? 0) > 1 ? `${peerName}/${a}` : a);
    }
  }
  return out;
}

export function resolveHandle(
  handle: string,
  peers: PeersConfig,
  localAgents: string[],
): ResolvedHandle {
  const { peer, agent } = parseScoped(handle);

  if (peer === "self") {
    if (!localAgents.includes(agent)) {
      throw new Error(`no local agent named ${agent}`);
    }
    return { kind: "local", agent };
  }

  if (peer) {
    const entry = peers.peers[peer];
    if (!entry) throw new Error(`unknown peer: ${peer}`);
    if (!entry.agents.includes(agent)) {
      throw new Error(`no agent ${agent} on peer ${peer}`);
    }
    return { kind: "remote", peer, agent };
  }

  const localMatch = localAgents.includes(agent);
  const remoteMatches = Object.entries(peers.peers)
    .filter(([, p]) => p.agents.includes(agent))
    .map(([peerName]) => peerName);

  const totalMatches = (localMatch ? 1 : 0) + remoteMatches.length;
  if (totalMatches === 0) throw new Error(`no agent named ${agent}`);
  if (totalMatches > 1) {
    const options = [
      ...(localMatch ? [`self/${agent}`] : []),
      ...remoteMatches.map((p) => `${p}/${agent}`),
    ];
    throw new Error(`ambiguous: ${options.join(" or ")}`);
  }
  if (localMatch) return { kind: "local", agent };
  return { kind: "remote", peer: remoteMatches[0], agent };
}
