import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { CONNECTION_EXTENSION_URL } from "./middleware.js";
import type {
  ConnectionRequestConfig,
  ConnectionRequest,
  FriendsConfig,
} from "./types.js";

interface ConnectionResponse {
  id: string;
  status: { state: string };
  artifacts: Array<{
    artifactId: string;
    parts: Array<{ kind: string; text: string }>;
    metadata: Record<string, Record<string, string>>;
  }>;
}

interface NewFriend {
  handle: string;
  fingerprint: string;
}

interface HandleConnectionRequestOpts {
  config: ConnectionRequestConfig;
  friends: FriendsConfig;
  fingerprint: string;
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
  newFriend?: NewFriend;
}

export function buildAcceptedResponse(): ConnectionResponse {
  return {
    id: uuidv4(),
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [
      {
        artifactId: "connection-result",
        parts: [{ kind: "text", text: "Connection accepted" }],
        metadata: {
          [CONNECTION_EXTENSION_URL]: {
            type: "accepted",
          },
        },
      },
    ],
  };
}

export function buildDeniedResponse(reason: string): ConnectionResponse {
  return {
    id: uuidv4(),
    status: { state: "TASK_STATE_REJECTED" },
    artifacts: [
      {
        artifactId: "connection-result",
        parts: [{ kind: "text", text: "Connection denied" }],
        metadata: {
          [CONNECTION_EXTENSION_URL]: {
            type: "denied",
            reason,
          },
        },
      },
    ],
  };
}

export function deriveHandle(
  name: string,
  existingFriends: FriendsConfig | Record<string, unknown>,
): string {
  const friends =
    "friends" in existingFriends
      ? (existingFriends as FriendsConfig).friends
      : (existingFriends as Record<string, unknown>);

  if (!(name in friends)) return name;

  let suffix = 2;
  while (`${name}-${suffix}` in friends) {
    suffix++;
  }
  return `${name}-${suffix}`;
}

export async function handleConnectionRequest(
  opts: HandleConnectionRequestOpts,
): Promise<HandleConnectionRequestResult> {
  const { config, friends, fingerprint, reason, agentCardUrl } = opts;

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
      const handle = deriveHandle(agentCard.name, friends);

      return {
        response: buildAcceptedResponse(),
        newFriend: { handle, fingerprint },
      };
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
        const handle = deriveHandle(agentCard.name, friends);
        return {
          response: buildAcceptedResponse(),
          newFriend: { handle, fingerprint },
        };
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
