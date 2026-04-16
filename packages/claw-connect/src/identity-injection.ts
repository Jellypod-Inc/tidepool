import type { RemoteAgent } from "./types.js";

/**
 * Inject `metadata.from = handle` into an A2A message body. If the body has
 * no `message` field, returns it unchanged. The injected value overwrites any
 * caller-supplied `metadata.from` — identity is server-authoritative.
 */
export function injectMetadataFrom<T extends Record<string, unknown>>(
  body: T,
  handle: string,
): T {
  const message = (body as { message?: Record<string, unknown> }).message;
  if (!message || typeof message !== "object") return body;
  const existingMetadata =
    (message.metadata as Record<string, unknown> | undefined) ?? {};
  message.metadata = { ...existingMetadata, from: handle };
  return body;
}

/**
 * Find the local handle the receiving host has assigned to a (peer, agent)
 * pair, from the static remotes config. Returns null if no match — caller
 * should reject with 403.
 */
export function resolveLocalHandleForRemoteSender(
  remoteAgents: RemoteAgent[],
  peerFingerprint: string,
  senderAgentName: string,
): string | null {
  const match = remoteAgents.find(
    (r) =>
      r.certFingerprint === peerFingerprint && r.remoteTenant === senderAgentName,
  );
  return match ? match.localHandle : null;
}
