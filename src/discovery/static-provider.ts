import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";
import type { StaticPeer } from "../types.js";

export class StaticProvider implements DiscoveryProvider {
  readonly name = "static";
  private peers: Record<string, StaticPeer>;

  constructor(peers: Record<string, StaticPeer>) {
    this.peers = peers;
  }

  async advertise(_agent: DiscoveredAgent): Promise<void> {
    // Static provider does not support advertising — entries are manual.
  }

  async deadvertise(): Promise<void> {
    // Static provider does not support deadvertising.
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    const agents = this.allAgents();

    if (query.handle) {
      return agents.filter((a) => a.handle === query.handle);
    }

    if (query.query) {
      const q = query.query.toLowerCase();
      return agents.filter(
        (a) =>
          a.handle.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
    }

    return agents;
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const peer = this.peers[handle];
    if (!peer) return null;

    return {
      handle,
      description: peer.description ?? handle,
      endpoint: peer.endpoint,
      agentCardUrl: peer.agentCardUrl,
      status: "offline",
    };
  }

  private allAgents(): DiscoveredAgent[] {
    return Object.entries(this.peers).map(([handle, peer]) => ({
      handle,
      description: peer.description ?? handle,
      endpoint: peer.endpoint,
      agentCardUrl: peer.agentCardUrl,
      status: "offline" as const,
    }));
  }
}
