import { randomUUID } from "node:crypto";

export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
  /** Session token returned by the daemon on registration; sent as X-Session-Id. */
  sessionId?: string;
};

export type SendErrorKind =
  | "daemon-down"
  | "peer-not-registered"
  | "peer-unreachable"
  | "other";

export class SendError extends Error {
  readonly kind: SendErrorKind;
  readonly hint: string;
  constructor(kind: SendErrorKind, message: string, hint: string) {
    super(message);
    this.name = "SendError";
    this.kind = kind;
    this.hint = hint;
  }
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|connection refused/i.test(msg);
}

/**
 * POST one message to one peer via the tidepool daemon's local proxy.
 *
 * The caller (channel.ts) owns contextId minting so a fan-out to N peers
 * shares one id. When `participants` is supplied (length >= 2 by convention),
 * it rides on message.metadata.participants and is preserved by the daemon's
 * metadata injection — receivers read it to know who else is in the thread.
 *
 * Returns {messageId} on success. Throws SendError on failure.
 */
export async function sendOutbound(args: {
  peer: string;
  contextId: string;
  text: string;
  self: string;
  participants?: string[];
  deps: OutboundDeps;
}): Promise<{ messageId: string }> {
  const { peer, contextId, text, self: _self, participants, deps } = args;
  const messageId = randomUUID();
  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;

  const message: {
    messageId: string;
    contextId: string;
    parts: Array<{ kind: "text"; text: string }>;
    metadata?: { participants: string[] };
  } = {
    messageId,
    contextId,
    parts: [{ kind: "text", text }],
  };
  if (participants && participants.length > 0) {
    message.metadata = { participants };
  }

  const daemonOrigin = `http://${host}:${deps.localPort}`;

  let res: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: daemonOrigin,
    };
    if (deps.sessionId) {
      headers["X-Session-Id"] = deps.sessionId;
    }
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw new SendError(
        "daemon-down",
        "the tidepool daemon isn't running",
        "Ask the user to run `tidepool claude-code:start` (or `tidepool start &`) and retry.",
      );
    }
    throw new SendError(
      "other",
      err instanceof Error ? err.message : String(err),
      "Ask the user to check `tidepool status` and the daemon log at ~/.config/tidepool/logs/.",
    );
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null as unknown);
    const code = (detail as { error?: { code?: string } })?.error?.code;
    const serverMessage = (detail as { error?: { message?: string } })?.error?.message;
    const hint = (detail as { error?: { hint?: string } })?.error?.hint ?? "";

    if (code === "peer_not_found" || code === "agent_offline") {
      throw new SendError(
        "peer-not-registered",
        serverMessage ?? `no agent named "${peer}"`,
        hint || "Call list_peers to see who's reachable. If the peer should exist, ask the user to confirm their session is running.",
      );
    }
    if (code === "peer_unreachable" || code === "peer_timeout") {
      throw new SendError(
        "peer-unreachable",
        serverMessage ?? `"${peer}" unreachable`,
        hint || `Check that "${peer}"'s session is still running.`,
      );
    }
    if (code === "origin_denied") {
      throw new SendError(
        "other",
        serverMessage ?? "origin rejected by daemon",
        hint || "This is a bug — the adapter should be sending a valid Origin header.",
      );
    }

    throw new SendError(
      "other",
      serverMessage ?? `HTTP ${res.status}`,
      hint || "Ask the user to check `tidepool status` and the daemon log.",
    );
  }

  return { messageId };
}
