import fs from "fs";
import TOML from "@iarna/toml";
import type { ServerConfig, FriendsConfig } from "./types.js";

export function loadServerConfig(filePath: string): ServerConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(content);

  const server = parsed.server as Record<string, unknown>;
  const agents = (parsed.agents ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const connectionRequests = (parsed.connectionRequests ?? {}) as Record<
    string,
    unknown
  >;
  const discovery = (parsed.discovery ?? {}) as Record<string, unknown>;

  return {
    server: {
      port: (server.port as number) ?? 9900,
      host: (server.host as string) ?? "0.0.0.0",
      localPort: (server.localPort as number) ?? 9901,
      rateLimit: (server.rateLimit as string) ?? "100/hour",
      streamTimeoutSeconds: (server.streamTimeoutSeconds as number) ?? 300,
    },
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, cfg]) => [
        name,
        {
          localEndpoint: cfg.localEndpoint as string,
          rateLimit: (cfg.rateLimit as string) ?? "50/hour",
          description: (cfg.description as string) ?? "",
          timeoutSeconds: (cfg.timeoutSeconds as number) ?? 30,
        },
      ]),
    ),
    connectionRequests: {
      mode: (connectionRequests.mode as "accept" | "deny" | "auto") ?? "deny",
      ...(connectionRequests.auto
        ? {
            auto: {
              model: (connectionRequests.auto as Record<string, unknown>).model as string,
              apiKeyEnv: (connectionRequests.auto as Record<string, unknown>).apiKeyEnv as string,
              policy: (connectionRequests.auto as Record<string, unknown>).policy as string,
            },
          }
        : {}),
    },
    discovery: {
      providers: (discovery.providers as string[]) ?? ["static"],
      cacheTtlSeconds: (discovery.cacheTtlSeconds as number) ?? 300,
      mdns: discovery.mdns
        ? { enabled: (discovery.mdns as Record<string, unknown>).enabled as boolean }
        : undefined,
      directory: discovery.directory
        ? {
            enabled: (discovery.directory as Record<string, unknown>).enabled as boolean,
            url: (discovery.directory as Record<string, unknown>).url as string,
          }
        : undefined,
      static: discovery.static
        ? {
            peers: Object.fromEntries(
              Object.entries(
                ((discovery.static as Record<string, unknown>).peers ?? {}) as Record<
                  string,
                  Record<string, unknown>
                >,
              ).map(([name, peer]) => [
                name,
                {
                  endpoint: peer.endpoint as string,
                  agentCardUrl: (peer.agentCardUrl ?? peer.agent_card_url) as string,
                  description: peer.description as string | undefined,
                },
              ]),
            ),
          }
        : undefined,
    },
  };
}

export function loadFriendsConfig(filePath: string): FriendsConfig {
  if (!fs.existsSync(filePath)) {
    return { friends: {} };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = TOML.parse(content);
  const friends = (parsed.friends ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  return {
    friends: Object.fromEntries(
      Object.entries(friends).map(([handle, entry]) => [
        handle,
        {
          fingerprint: entry.fingerprint as string,
          agents: entry.agents as string[] | undefined,
        },
      ]),
    ),
  };
}
