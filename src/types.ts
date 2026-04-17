export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
    streamTimeoutSeconds: number;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: ConnectionRequestConfig;
  discovery: DiscoveryConfig;
  validation: ValidationConfig;
}

export interface StaticPeer {
  endpoint: string;
  agentCardUrl: string;
  description?: string;
}

export interface DiscoveryConfig {
  providers: string[];
  cacheTtlSeconds: number;
  mdns?: {
    enabled: boolean;
  };
  directory?: {
    enabled: boolean;
    url: string;
  };
  static?: {
    peers: Record<string, StaticPeer>;
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

export interface RemotesConfig {
  remotes: Record<string, RemoteAgent>;
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

export interface ValidationConfig {
  mode: "warn" | "enforce";
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

/**
 * Fragment of an agent card contributed by the adapter at registration.
 * Daemon merges this with its own transport-layer fields to produce the
 * public agent card.
 */
export interface AgentCardFragment {
  description?: string;
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
  }>;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extensions?: Array<{ uri: string; description?: string; required?: boolean }>;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  iconUrl?: string;
  documentationUrl?: string;
}

/**
 * Inputs the daemon owns when constructing a public agent card.
 */
export interface AgentCardTransport {
  name: string;
  publicUrl: string;
  tenant: string;
  version?: string;
  provider?: { organization?: string; url?: string };
}

export interface RegisteredSession {
  /** Agent's local name (e.g., "alice"). */
  name: string;
  /** Adapter's inbound URL for A2A POST delivery. */
  endpoint: string;
  /** Card fragment the adapter contributed at registration. */
  card: AgentCardFragment;
  /** Session identifier echoed back to the adapter. */
  sessionId: string;
  /** When the session was registered. */
  registeredAt: Date;
}
