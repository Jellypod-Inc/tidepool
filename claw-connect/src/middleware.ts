import forge from "node-forge";
import type {
  FriendsConfig,
  FriendEntry,
  ServerConfig,
  AgentConfig,
} from "./types.js";

export const CONNECTION_EXTENSION_URL =
  "https://clawconnect.dev/ext/connection/v1";

interface FriendLookup {
  handle: string;
  friend: FriendEntry;
}

export function checkFriend(
  friends: FriendsConfig,
  fingerprint: string,
): FriendLookup | null {
  for (const [handle, entry] of Object.entries(friends.friends)) {
    if (entry.fingerprint === fingerprint) {
      return { handle, friend: entry };
    }
  }
  return null;
}

export function checkAgentScope(friend: FriendEntry, tenant: string): boolean {
  if (!friend.agents) return true; // unscoped = all agents
  return friend.agents.includes(tenant);
}

export function resolveTenant(
  config: ServerConfig,
  tenant: string,
): AgentConfig | null {
  return config.agents[tenant] ?? null;
}

/**
 * Extract SHA-256 fingerprint from a raw DER certificate buffer.
 * This is the buffer you get from `socket.getPeerCertificate().raw`.
 */
export function extractFingerprint(raw: Buffer | undefined): string | null {
  if (!raw || raw.length === 0) return null;

  const md = forge.md.sha256.create();
  md.update(raw.toString("binary"));
  return `sha256:${md.digest().toHex()}`;
}

/**
 * Check if an inbound A2A request is a CONNECTION_REQUEST.
 *
 * Per v1.0, clients MAY signal an extension via `message.extensions[]` AND/OR
 * the `X-A2A-Extensions` request header. We treat either signal as sufficient
 * and additionally require the first text part to be "CONNECTION_REQUEST".
 */
export function isConnectionRequest(
  body: unknown,
  headers: Record<string, unknown>,
): boolean {
  if (!body || typeof body !== "object") return false;

  const msg = (body as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return false;

  const message = msg as Record<string, unknown>;

  const inBodyExtensions = Array.isArray(message.extensions)
    ? (message.extensions as string[])
    : [];

  // `X-A2A-Extensions` header — express normalizes header names to lowercase.
  const headerRaw = headers["x-a2a-extensions"];
  const headerValue = typeof headerRaw === "string" ? headerRaw : undefined;
  const inHeaderExtensions = headerValue
    ? headerValue.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const declaresExtension =
    inBodyExtensions.includes(CONNECTION_EXTENSION_URL) ||
    inHeaderExtensions.includes(CONNECTION_EXTENSION_URL);

  if (!declaresExtension) return false;

  const parts = message.parts as Array<Record<string, string>> | undefined;
  if (!parts || !Array.isArray(parts) || parts.length === 0) return false;

  return parts[0].text === "CONNECTION_REQUEST";
}

/**
 * Extract connection request metadata from a validated CONNECTION_REQUEST body.
 */
export function extractConnectionMetadata(
  body: Record<string, unknown>,
): { reason: string; agentCardUrl: string } | null {
  const msg = body.message as Record<string, unknown>;
  const metadata = msg.metadata as Record<string, Record<string, string>> | undefined;
  if (!metadata) return null;

  const ext = metadata[CONNECTION_EXTENSION_URL];
  if (!ext || ext.type !== "request") return null;

  return {
    reason: ext.reason ?? "",
    agentCardUrl: ext.agent_card_url ?? "",
  };
}
