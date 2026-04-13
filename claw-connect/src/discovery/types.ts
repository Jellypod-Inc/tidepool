export interface DiscoveredAgent {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  status: "online" | "offline";
}

export interface DiscoveryProvider {
  name: string;
  advertise(agent: DiscoveredAgent): Promise<void>;
  deadvertise(): Promise<void>;
  search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]>;
  resolve(handle: string): Promise<DiscoveredAgent | null>;
}
