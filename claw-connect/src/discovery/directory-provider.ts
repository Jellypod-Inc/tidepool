import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";

export class DirectoryProvider implements DiscoveryProvider {
  readonly name = "directory";
  private directoryUrl: string;
  private fingerprint: string;

  constructor(directoryUrl: string, fingerprint: string) {
    this.directoryUrl = directoryUrl.replace(/\/$/, "");
    this.fingerprint = fingerprint;
  }

  async advertise(agent: DiscoveredAgent): Promise<void> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": this.fingerprint,
      },
      body: JSON.stringify({
        handle: agent.handle,
        description: agent.description,
        endpoint: agent.endpoint,
        agentCardUrl: agent.agentCardUrl,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        `Directory registration failed: ${res.status} ${(data as any).error ?? res.statusText}`,
      );
    }
  }

  async deadvertise(): Promise<void> {
    // Deregistration not implemented in v1 — agents go offline via heartbeat timeout.
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    // Exact handle lookups hit /v1/agents/:handle instead of doing a substring
    // search + client-side filter.
    if (query.handle) {
      const resolved = await this.resolve(query.handle);
      return resolved ? [resolved] : [];
    }

    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);

    const url = `${this.directoryUrl}/v1/agents/search?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) return [];

    const data = (await res.json()) as { agents: DiscoveredAgent[] };
    return data.agents;
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/${encodeURIComponent(handle)}`);

    if (res.status === 404) return null;
    if (!res.ok) return null;

    return (await res.json()) as DiscoveredAgent;
  }

  async heartbeat(handle: string): Promise<void> {
    const res = await fetch(`${this.directoryUrl}/v1/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Fingerprint": this.fingerprint,
      },
      body: JSON.stringify({ handle }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        `Heartbeat failed: ${res.status} ${(data as any).error ?? res.statusText}`,
      );
    }
  }
}
