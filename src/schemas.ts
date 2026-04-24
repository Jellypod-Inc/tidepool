import { z } from "zod";

/**
 * Zod schemas for Tidepool-specific structures (server config, friends
 * config, directory responses). A2A wire-shape schemas live in a2a.ts.
 */

// --- Shared atoms ---

const RateLimitString = z.string().min(1);

// --- ServerConfig ---

const AgentConfigSchema = z.object({
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
    port: z.number().int().min(0).default(9900),
    host: z.string().default("0.0.0.0"),
    localPort: z.number().int().min(0).default(9901),
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

// --- PeersConfig ---

const PeerAgentNameSchema = z.string().min(1);

const PeerEntrySchema = z
  .object({
    did: z.string().regex(/^did:dht:[A-Za-z0-9]+$/).optional(),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    endpoint: z.string().url(),
    agents: z.array(PeerAgentNameSchema).default([]),
  })
  .refine((p) => p.did || p.fingerprint, {
    message: "peer must have did or fingerprint (or both)",
  });

export const PeersConfigSchema = z.object({
  peers: z.record(z.string().min(1), PeerEntrySchema).default({}),
});

// --- Multi-party broadcast (local plane: adapter → daemon) ---

export const BroadcastRequestSchema = z.object({
  peers: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  thread: z.string().uuid().optional(),
  addressed_to: z.array(z.string().min(1)).optional(),
  in_reply_to: z.string().min(1).optional(),
});
export type BroadcastRequest = z.infer<typeof BroadcastRequestSchema>;

export const BroadcastResultItemSchema = z.object({
  peer: z.string(),
  delivery: z.enum(["accepted", "failed"]),
  reason: z
    .object({
      kind: z.enum([
        "daemon-down",
        "peer-not-registered",
        "peer-unreachable",
        "other",
      ]),
      message: z.string(),
      hint: z.string().optional(),
    })
    .optional(),
});
export type BroadcastResultItem = z.infer<typeof BroadcastResultItemSchema>;

export const BroadcastResponseSchema = z.object({
  context_id: z.string().uuid(),
  message_id: z.string().uuid(),
  results: z.array(BroadcastResultItemSchema),
});
export type BroadcastResponse = z.infer<typeof BroadcastResponseSchema>;
