import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { CONNECTION_EXTENSION_URL } from "./middleware.js";
import type { Message } from "./a2a.js";
import type {
  ConnectionRequestConfig,
  ConnectionRequest,
  PeersConfig,
} from "./types.js";

// The handshake response is a v1.0 Message with the connection-extension
// metadata attached. Callers expose it as the body of a message:send reply.
type ConnectionResponse = Message;

interface HandleConnectionRequestOpts {
  config: ConnectionRequestConfig;
  peers: PeersConfig;
  writePeers: (cfg: PeersConfig) => void;
  fingerprint: string;
  endpoint: string;
  reason: string;
  agentCardUrl: string;
  fetchAgentCard: (url: string) => Promise<{ name: string }>;
  evaluateWithLLM?: (opts: {
    reason: string;
    agentCardUrl: string;
    agentName: string;
    policy: string;
  }) => Promise<{ decision: "accept" | "deny"; reason?: string }>;
  pendingRequestsPath?: string;
}

interface HandleConnectionRequestResult {
  response: ConnectionResponse;
}

export function buildAcceptedResponse(): ConnectionResponse {
  return {
    messageId: uuidv4(),
    role: "agent",
    parts: [{ kind: "text", text: "Connection accepted" }],
    metadata: {
      [CONNECTION_EXTENSION_URL]: { type: "accepted" },
    },
  };
}

export function buildDeniedResponse(reason: string): ConnectionResponse {
  return {
    messageId: uuidv4(),
    role: "agent",
    parts: [{ kind: "text", text: "Connection denied" }],
    metadata: {
      [CONNECTION_EXTENSION_URL]: { type: "denied", reason },
    },
  };
}

export function findPeerByFingerprint(
  peers: PeersConfig,
  fp: string,
): string | null {
  const t = fp.toLowerCase();
  for (const [handle, entry] of Object.entries(peers.peers)) {
    if (entry.fingerprint?.toLowerCase() === t) return handle;
  }
  return null;
}

export function deriveHandle(
  agentCardName: string | undefined,
  fingerprint: string,
): string {
  const safe = (agentCardName ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (safe) return safe;
  return "peer-" + fingerprint.replace("sha256:", "").slice(0, 8);
}

function persistPeer(
  opts: HandleConnectionRequestOpts,
  agentCardName: string,
): void {
  // Idempotent: skip if fingerprint already present
  if (findPeerByFingerprint(opts.peers, opts.fingerprint)) return;

  const handle = deriveHandle(agentCardName, opts.fingerprint);
  // Fall back to fingerprint-derived handle if name collides with a different peer
  const finalHandle =
    opts.peers.peers[handle] !== undefined
      ? deriveHandle(undefined, opts.fingerprint)
      : handle;

  opts.peers.peers[finalHandle] = {
    fingerprint: opts.fingerprint,
    endpoint: opts.endpoint,
    agents: [agentCardName],
  };
  opts.writePeers(opts.peers);
}

export async function handleConnectionRequest(
  opts: HandleConnectionRequestOpts,
): Promise<HandleConnectionRequestResult> {
  const { config, fingerprint, reason, agentCardUrl } = opts;

  switch (config.mode) {
    case "deny": {
      if (opts.pendingRequestsPath) {
        storePendingRequest(opts.pendingRequestsPath, {
          fingerprint,
          reason,
          agentCardUrl,
          receivedAt: new Date(),
        });
      }
      return {
        response: buildDeniedResponse("Not accepting connections at this time"),
      };
    }

    case "accept": {
      const agentCard = await opts.fetchAgentCard(agentCardUrl);
      persistPeer(opts, agentCard.name);
      return { response: buildAcceptedResponse() };
    }

    case "auto": {
      if (!config.auto) {
        throw new Error(
          "auto mode requires connectionRequests.auto configuration in server.toml",
        );
      }

      const agentCard = await opts.fetchAgentCard(agentCardUrl);

      const evaluate =
        opts.evaluateWithLLM ?? (await createDefaultEvaluator(config));
      const decision = await evaluate({
        reason,
        agentCardUrl,
        agentName: agentCard.name,
        policy: config.auto.policy,
      });

      if (decision.decision === "accept") {
        persistPeer(opts, agentCard.name);
        return { response: buildAcceptedResponse() };
      }

      return {
        response: buildDeniedResponse(
          decision.reason ?? "Connection request denied by policy",
        ),
      };
    }

    default:
      return {
        response: buildDeniedResponse("Unknown connection mode"),
      };
  }
}

async function createDefaultEvaluator(
  config: ConnectionRequestConfig,
): Promise<
  (opts: {
    reason: string;
    agentCardUrl: string;
    agentName: string;
    policy: string;
  }) => Promise<{ decision: "accept" | "deny"; reason?: string }>
> {
  const { generateText } = await import("ai");

  const apiKey = config.auto?.apiKeyEnv
    ? process.env[config.auto.apiKeyEnv]
    : undefined;

  if (!apiKey) {
    throw new Error(
      `Environment variable ${config.auto?.apiKeyEnv} is not set (needed for auto mode)`,
    );
  }

  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey });

  return async (opts) => {
    const result = await generateText({
      model: anthropic(config.auto!.model),
      system: `You are a connection request evaluator for an A2A (agent-to-agent) network.

Your job is to decide whether to accept or deny a connection request based on the server owner's policy.

Policy:
${opts.policy}

Respond with exactly one of these two formats:
ACCEPT
or
DENY: <reason>

Nothing else. No explanation, no markdown, no extra text.`,
      prompt: `Connection request from agent "${opts.agentName}":
Reason: ${opts.reason}
Agent Card URL: ${opts.agentCardUrl}`,
    });

    const text = result.text.trim();

    if (text === "ACCEPT") {
      return { decision: "accept" };
    }

    const denyMatch = text.match(/^DENY:\s*(.+)$/s);
    if (denyMatch) {
      return { decision: "deny", reason: denyMatch[1].trim() };
    }

    return { decision: "deny", reason: "Could not evaluate request" };
  };
}

// --- Pending requests storage ---

interface StoredRequest {
  fingerprint: string;
  reason: string;
  agentCardUrl: string;
  receivedAt: string;
}

export function storePendingRequest(
  filePath: string,
  request: ConnectionRequest,
): void {
  const existing = loadPendingRequests(filePath);

  const filtered = existing.filter(
    (r) => r.fingerprint !== request.fingerprint,
  );
  filtered.push({
    fingerprint: request.fingerprint,
    reason: request.reason,
    agentCardUrl: request.agentCardUrl,
    receivedAt: request.receivedAt.toISOString(),
  });

  fs.writeFileSync(
    filePath,
    JSON.stringify({ requests: filtered }, null, 2),
  );
}

export function loadPendingRequests(filePath: string): StoredRequest[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as { requests: StoredRequest[] };
    return parsed.requests ?? [];
  } catch {
    return [];
  }
}
