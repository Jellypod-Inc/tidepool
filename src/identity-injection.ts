import type { RemoteAgent, PeersConfig } from "./types.js";
import type { ThreadIndex } from "./thread-index.js";
import { agentDidToHandle } from "./peers/resolve.js";

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
 * Strip any caller-supplied `metadata.from` from an A2A message body. Used on
 * local→remote outbound: the receiving server is responsible for injecting
 * `from` based on authenticated headers, so anything the caller set here is
 * noise at best and a spoofing attempt at worst. Defense-in-depth; the
 * receiver always overwrites.
 */
export function stripMetadataFrom<T extends Record<string, unknown>>(
  body: T,
): T {
  const message = (body as { message?: Record<string, unknown> }).message;
  if (!message || typeof message !== "object") return body;
  const existing = message.metadata as Record<string, unknown> | undefined;
  if (!existing || !("from" in existing)) return body;
  const { from: _from, ...rest } = existing;
  message.metadata = rest;
  return body;
}

export interface StampInboundOpts {
  /** The receiver-view handle of the sender (injected into metadata.from). */
  from: string;
  /**
   * The local agent name being delivered to. The caller is responsible for
   * passing the correct receiver-view handle (bare or self/<name> as
   * appropriate) — use projectHandles to derive this if needed.
   */
  self: string;
  /** Peers config for re-projection of DID arrays. */
  peers: PeersConfig;
  /** Local agent names for projection context. */
  localAgents: string[];
  /** Shared thread-index to record message_id for future in_reply_to validation. */
  threadIndex: ThreadIndex;
}

/**
 * Extended inbound stamping. Stamps metadata.from and metadata.self, and
 * re-projects metadata.participants and metadata.addressed_to from wire-level
 * DIDs to the receiver's handle projection. Unknown DIDs are passed through
 * opaquely (never dropped). Records contextId+messageId into the thread-index.
 */
export function stampInboundMetadata<T extends Record<string, unknown>>(
  body: T,
  opts: StampInboundOpts,
): T {
  const message = (body as { message?: Record<string, unknown> }).message;
  if (!message || typeof message !== "object") return body;

  const existing = (message.metadata as Record<string, unknown> | undefined) ?? {};
  const metadata: Record<string, unknown> = { ...existing };

  // Stamp from + self (server-authoritative, overwrites anything caller set)
  metadata.from = opts.from;
  metadata.self = opts.self;

  // Re-project participants from DID array to receiver-view handles
  const rawParticipants = existing.participants;
  if (Array.isArray(rawParticipants)) {
    metadata.participants = rawParticipants.map((entry) => {
      if (typeof entry !== "string") return entry;
      try {
        return agentDidToHandle(entry, opts.peers, opts.localAgents);
      } catch {
        return entry; // unknown DID — pass through opaquely
      }
    });
  }

  // Re-project addressed_to from DID array to receiver-view handles
  const rawAddressedTo = existing.addressed_to;
  if (Array.isArray(rawAddressedTo)) {
    metadata.addressed_to = rawAddressedTo.map((entry) => {
      if (typeof entry !== "string") return entry;
      try {
        return agentDidToHandle(entry, opts.peers, opts.localAgents);
      } catch {
        return entry;
      }
    });
  }

  message.metadata = metadata;

  // Record into thread-index for future in_reply_to validation
  const contextId = typeof message.contextId === "string" ? message.contextId : undefined;
  const messageId = typeof message.messageId === "string" ? message.messageId : undefined;
  if (contextId && messageId) {
    opts.threadIndex.record(contextId, messageId);
  }

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
