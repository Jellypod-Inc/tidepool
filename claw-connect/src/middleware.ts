import forge from "node-forge";
import type {
  FriendsConfig,
  FriendEntry,
  ServerConfig,
  AgentConfig,
} from "./types.js";

const EXTENSION_URL = "https://clawconnect.dev/ext/connection/v1";

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
 * Check if an inbound A2A request body is a CONNECTION_REQUEST.
 * Looks for the Claw Connect connection extension in the message.
 */
export function isConnectionRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;

  const msg = (body as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return false;

  const message = msg as Record<string, unknown>;
  const extensions = message.extensions as string[] | undefined;
  if (!extensions || !Array.isArray(extensions)) return false;

  if (!extensions.includes(EXTENSION_URL)) return false;

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

  const ext = metadata[EXTENSION_URL];
  if (!ext || ext.type !== "request") return null;

  return {
    reason: ext.reason ?? "",
    agentCardUrl: ext.agent_card_url ?? "",
  };
}
