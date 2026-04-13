export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: ConnectionRequestConfig;
  discovery: {
    providers: string[];
    cacheTtlSeconds: number;
  };
}

export interface AgentConfig {
  localEndpoint: string;
  rateLimit: string;
  description: string;
  timeoutSeconds: number;
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

export interface ConnectionRequestAutoConfig {
  model: string;
  apiKeyEnv: string;
  policy: string;
}

export interface ConnectionRequestConfig {
  mode: "accept" | "deny" | "auto";
  auto?: ConnectionRequestAutoConfig;
}

export interface ConnectionRequest {
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  receivedAt: Date;
}

export interface PendingRequests {
  requests: ConnectionRequest[];
}
