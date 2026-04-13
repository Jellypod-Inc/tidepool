export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: {
    mode: "accept" | "deny" | "auto";
  };
  discovery: {
    providers: string[];
    cacheTtlSeconds: number;
  };
}

export interface AgentConfig {
  localEndpoint: string;
  rateLimit: string;
  description: string;
}

export interface FriendEntry {
  fingerprint: string;
  agents?: string[];
}

export interface FriendsConfig {
  friends: Record<string, FriendEntry>;
}

export interface RemoteAgent {
  localHandle: string;
  remoteEndpoint: string;
  remoteTenant: string;
  certFingerprint: string;
}

export interface AgentIdentity {
  name: string;
  certPath: string;
  keyPath: string;
  fingerprint: string;
}
