import { Bonjour, type Service } from "bonjour-service";
import type { DiscoveredAgent, DiscoveryProvider } from "./types.js";

const SERVICE_TYPE = "a2a";
const SERVICE_PROTOCOL = "tcp" as const;

export class MdnsProvider implements DiscoveryProvider {
  readonly name = "mdns";
  private bonjour: Bonjour;
  private publishedService: Service | null = null;

  constructor() {
    this.bonjour = new Bonjour();
  }

  async advertise(agent: DiscoveredAgent): Promise<void> {
    if (this.publishedService) {
      this.publishedService.stop?.();
      this.publishedService = null;
    }

    const url = new URL(agent.endpoint);
    const port = parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80);

    this.publishedService = this.bonjour.publish({
      name: agent.handle,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      txt: {
        handle: agent.handle,
        description: agent.description,
        endpoint: agent.endpoint,
        agentCardUrl: agent.agentCardUrl,
        status: agent.status,
      },
    });
  }

  async deadvertise(): Promise<void> {
    if (this.publishedService) {
      this.publishedService.stop?.();
      this.publishedService = null;
    }
  }

  async search(query: { query?: string; handle?: string }): Promise<DiscoveredAgent[]> {
    return new Promise((resolve) => {
      const agents: DiscoveredAgent[] = [];

      const browser = this.bonjour.find(
        { type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL },
        (service) => {
          const agent = this.serviceToAgent(service);
          if (!agent) return;

          if (query.handle && agent.handle !== query.handle) return;
          if (query.query) {
            const q = query.query.toLowerCase();
            if (
              !agent.handle.toLowerCase().includes(q) &&
              !agent.description.toLowerCase().includes(q)
            ) {
              return;
            }
          }

          agents.push(agent);
        },
      );

      setTimeout(() => {
        browser.stop();
        resolve(agents);
      }, 1000);
    });
  }

  async resolve(handle: string): Promise<DiscoveredAgent | null> {
    const results = await this.search({ handle });
    return results[0] ?? null;
  }

  destroy(): void {
    this.bonjour.destroy();
  }

  private serviceToAgent(service: Service): DiscoveredAgent | null {
    const txt = service.txt as Record<string, string> | undefined;
    if (!txt?.handle || !txt?.endpoint) return null;

    return {
      handle: txt.handle,
      description: txt.description ?? service.name,
      endpoint: txt.endpoint,
      agentCardUrl:
        txt.agentCardUrl ??
        `${txt.endpoint}/${txt.handle}/.well-known/agent-card.json`,
      status: (txt.status as "online" | "offline") ?? "online",
    };
  }
}
