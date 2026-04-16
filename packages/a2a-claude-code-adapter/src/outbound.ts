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
 * Fire-and-forget outbound. Awaits only the ack from the local claw-connect
 * (HTTP 200 with a Task in `completed` state). Any reply from the peer
 * arrives later as a separate inbound POST handled by http.ts.
 *
 * Returns {contextId, messageId} on success. Throws `SendError` on failure;
 * caller (channel.ts) wraps it into an MCP `isError: true` result.
 */
export async function sendOutbound(args: {
  peer: string;
  text: string;
  self: string;
  thread?: string;
  deps: OutboundDeps;
}): Promise<{ contextId: string; messageId: string }> {
  const { peer, text, self, thread, deps } = args;
  const messageId = randomUUID();
  const contextId = thread ?? randomUUID();
  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;

  const body = {
    message: {
      messageId,
      contextId,
      parts: [{ kind: "text", text }],
    },
  };

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent": self,
      },
      body: JSON.stringify(body),
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

  return { contextId, messageId };
}
