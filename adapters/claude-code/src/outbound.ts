export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
  /** Session token from daemon registration; sent as X-Session-Id. */
  sessionId: string;
};

export type BroadcastErrorKind =
  | "daemon-down"
  | "peer-not-registered"
  | "peer-unreachable"
  | "other";

/** Mirror of daemon BroadcastResultItem. Keep in sync with src/schemas.ts. */
export interface BroadcastResultItem {
  peer: string;
  delivery: "accepted" | "failed";
  reason?: {
    kind: BroadcastErrorKind;
    message: string;
    hint?: string;
  };
}

/** Mirror of daemon BroadcastResponse. */
export interface BroadcastResponse {
  context_id: string;
  message_id: string;
  results: BroadcastResultItem[];
}

export class BroadcastError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown, message?: string) {
    super(message ?? `broadcast_failed:${status}`);
    this.name = "BroadcastError";
    this.status = status;
    this.detail = detail;
  }
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|connection refused/i.test(msg);
}

/**
 * Single-call multi-peer send. The daemon mints the shared message_id and
 * context_id, handles per-peer fanout, stamps envelope metadata (participants,
 * self, etc.) as canonical DIDs re-projected per recipient.
 *
 * Throws BroadcastError with status=0 on daemon-down (connection refused),
 * status=non-2xx with parsed body on HTTP error, or rethrown on unexpected
 * transport errors.
 */
export async function sendBroadcast(opts: {
  peers: string[];
  text: string;
  thread?: string;
  addressed_to?: string[];
  in_reply_to?: string;
  deps: OutboundDeps;
}): Promise<BroadcastResponse> {
  const { peers, text, thread, addressed_to, in_reply_to, deps } = opts;
  if (peers.length === 0) {
    throw new BroadcastError(400, { code: "invalid_body" }, "peers must be non-empty");
  }

  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/message:broadcast`;

  const body = {
    peers,
    text,
    ...(thread ? { thread } : {}),
    ...(addressed_to ? { addressed_to } : {}),
    ...(in_reply_to ? { in_reply_to } : {}),
  };

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": deps.sessionId,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (isConnectionRefused(e)) {
      throw new BroadcastError(0, { code: "daemon-down" }, "daemon not reachable on loopback");
    }
    throw e;
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new BroadcastError(res.status, detail);
  }

  return (await res.json()) as BroadcastResponse;
}
