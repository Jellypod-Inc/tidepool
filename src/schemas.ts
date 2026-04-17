import { z } from "zod";

/**
 * Zod schemas for Tidepool-specific structures (server config, friends
 * config, directory responses). A2A wire-shape schemas live in a2a.ts.
 */

// --- Shared atoms ---

const RateLimitString = z.string().min(1);

// --- ServerConfig ---

const AgentConfigSchema = z.object({
  localEndpoint: z.string().min(1),
  rateLimit: RateLimitString.default("50/hour"),
  description: z.string().default(""),
  timeoutSeconds: z.number().positive().default(30),
});

const ConnectionRequestAutoSchema = z.object({
  model: z.string(),
  apiKeyEnv: z.string(),
  policy: z.string(),
});

const ConnectionRequestConfigSchema = z.object({
  mode: z.enum(["accept", "deny", "auto"]).default("deny"),
  auto: ConnectionRequestAutoSchema.optional(),
});

const StaticPeerSchema = z.object({
  endpoint: z.string().min(1),
  agentCardUrl: z.string().optional(),
  agent_card_url: z.string().optional(),
  description: z.string().optional(),
}).transform((v) => ({
  endpoint: v.endpoint,
  agentCardUrl: (v.agentCardUrl ?? v.agent_card_url) as string,
  description: v.description,
}));

const DiscoveryConfigSchema = z.object({
  providers: z.array(z.string()).default(["static"]),
  cacheTtlSeconds: z.number().positive().default(300),
  mdns: z.object({ enabled: z.boolean() }).optional(),
  directory: z
    .object({ enabled: z.boolean(), url: z.string().min(1) })
    .optional(),
  static: z
    .object({ peers: z.record(z.string(), StaticPeerSchema) })
    .optional(),
});

const ValidationConfigSchema = z.object({
  mode: z.enum(["warn", "enforce"]).default("warn"),
});

export const ServerConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(9900),
    host: z.string().default("0.0.0.0"),
    localPort: z.number().int().positive().default(9901),
    rateLimit: RateLimitString.default("100/hour"),
    streamTimeoutSeconds: z.number().positive().default(300),
  }),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  connectionRequests: ConnectionRequestConfigSchema.default({ mode: "deny" }),
  discovery: DiscoveryConfigSchema.default({
    providers: ["static"],
    cacheTtlSeconds: 300,
  }),
  validation: ValidationConfigSchema.default({ mode: "warn" }),
});

// --- FriendsConfig ---

const FriendEntrySchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  agents: z.array(z.string()).optional(),
});

export const FriendsConfigSchema = z.object({
  friends: z.record(z.string(), FriendEntrySchema).default({}),
});

// --- RemotesConfig ---

const RemoteAgentSchema = z.object({
  localHandle: z.string().min(1),
  remoteEndpoint: z.url(),
  remoteTenant: z.string().min(1),
  certFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

export const RemotesConfigSchema = z.object({
  remotes: z.record(z.string(), RemoteAgentSchema).default({}),
});

// --- DiscoveredAgent (from our directory — not the A2A spec) ---

export const DiscoveredAgentSchema = z.object({
  handle: z.string().min(1),
  description: z.string().default(""),
  endpoint: z.string().min(1),
  agentCardUrl: z.string().min(1),
  status: z.enum(["online", "offline"]),
});

export const DirectorySearchResponseSchema = z.object({
  agents: z.array(DiscoveredAgentSchema),
});
