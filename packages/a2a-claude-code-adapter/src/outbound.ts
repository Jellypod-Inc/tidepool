import { randomUUID } from "node:crypto";
import type { InboundInfo } from "./http.js";

export type OutboundDeps = {
  localPort: number;
  host?: string;
  fetchImpl?: typeof fetch;
  onReply: (info: InboundInfo) => void;
};

type A2AResponse = {
  id?: string;
  contextId?: string;
  status?: { state?: string; message?: string };
  artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
};

function extractReplyText(body: A2AResponse): string {
  const parts = body.artifacts?.[0]?.parts ?? [];
  for (const p of parts) {
    if (typeof p?.text === "string") return p.text;
  }
  return "";
}

/**
 * Wrap a send failure in a message that tells the user what to do.
 *
 * The recovery hint is the important part: these channel events land in front
 * of Claude, who will repeat the fix to the human. Keep them imperative.
 */
function formatError(peer: string, cause: string, hint: string): string {
  return `[claw-connect] send to "${peer}" failed: ${cause}\n\nHow to recover: ${hint}`;
}

function describeNetworkError(err: unknown): {
  kind: "connection-refused" | "other";
  raw: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  const refused =
    code === "ECONNREFUSED" ||
    /ECONNREFUSED|connection refused/i.test(msg);
  return { kind: refused ? "connection-refused" : "other", raw: msg };
}

/**
 * Fire-and-forget outbound message. Returns a task_id the agent can correlate
 * later; the peer's reply (or any error) is surfaced as a channel notification
 * with the same task_id via `onReply`.
 */
export async function sendOutbound(args: {
  peer: string;
  text: string;
  deps: OutboundDeps;
}): Promise<{ taskId: string }> {
  const { peer, text, deps } = args;
  const taskId = randomUUID();
  const contextId = randomUUID();
  const host = deps.host ?? "127.0.0.1";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `http://${host}:${deps.localPort}/${encodeURIComponent(peer)}/message:send`;

  const body = {
    message: {
      messageId: taskId,
      contextId,
      role: "user",
      parts: [{ kind: "text", text }],
    },
  };

  // The POST is started synchronously but not awaited here — the tool call
  // returns the task_id immediately and the result arrives later as a channel
  // notification. Callers should not await this promise.
  void (async () => {
    let replyText: string;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as A2AResponse;

      if (res.ok && json.status?.state === "completed") {
        replyText = extractReplyText(json);
      } else if (res.status === 404) {
        replyText = formatError(
          peer,
          `no agent named "${peer}" is registered with the claw-connect daemon`,
          `Call claw_connect_list_peers to see available handles. If "${peer}" should exist, ask the user to confirm that their claw-connect claude-code:start session is still running.`,
        );
      } else if (res.status === 504 || json.status?.state === "failed") {
        replyText = formatError(
          peer,
          `"${peer}" is registered but didn't respond in time${json.status?.message ? ` (${json.status.message})` : ""}`,
          `"${peer}"'s adapter may be down. Ask the user to check that the other terminal still has an active claude-code:start session for "${peer}".`,
        );
      } else {
        const reason =
          json.status?.message ??
          `HTTP ${res.status} (state=${json.status?.state ?? "unknown"})`;
        replyText = formatError(
          peer,
          reason,
          `Ask the user to check 'claw-connect status' and the daemon log at ~/.config/claw-connect/logs/.`,
        );
      }
    } catch (err) {
      const { kind, raw } = describeNetworkError(err);
      if (kind === "connection-refused") {
        replyText = formatError(
          peer,
          `the claw-connect daemon isn't running`,
          `Ask the user to run 'claw-connect claude-code:start' in a project directory (or 'claw-connect serve &' in any terminal) to bring the daemon back up, then retry claw_connect_send.`,
        );
      } else {
        replyText = formatError(
          peer,
          raw,
          `Ask the user to check 'claw-connect status' and the daemon log at ~/.config/claw-connect/logs/.`,
        );
      }
    }

    deps.onReply({
      taskId,
      contextId,
      messageId: null,
      text: replyText,
    });
  })();

  return { taskId };
}
