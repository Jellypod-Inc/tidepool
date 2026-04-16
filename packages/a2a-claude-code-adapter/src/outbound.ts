import { randomUUID } from "node:crypto";

export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
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
 * POST one message to one peer via the claw-connect daemon's local proxy.
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
  const { peer, contextId, text, self, participants, deps } = args;
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

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent": self,
      },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw new SendError(
        "daemon-down",
        "the claw-connect daemon isn't running",
        "Ask the user to run `claw-connect claude-code:start` (or `claw-connect serve &`) and retry.",
      );
    }
    throw new SendError(
      "other",
      err instanceof Error ? err.message : String(err),
      "Ask the user to check `claw-connect status` and the daemon log at ~/.config/claw-connect/logs/.",
    );
  }

  if (res.status === 403 || res.status === 404) {
    throw new SendError(
      "peer-not-registered",
      `no agent named "${peer}" is registered`,
      "Call list_peers to see who's reachable. If the peer should exist, ask the user to confirm their session is running.",
    );
  }
  if (res.status === 504) {
    throw new SendError(
      "peer-unreachable",
      `"${peer}" is registered but didn't respond`,
      `Check that "${peer}"'s session is still running.`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SendError(
      "other",
      `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      "Ask the user to check `claw-connect status` and the daemon log.",
    );
  }

  return { messageId };
}
