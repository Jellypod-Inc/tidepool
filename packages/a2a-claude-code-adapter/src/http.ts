import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { PendingRegistry } from "./pending.js";

export type InboundInfo = {
  taskId: string;
  // contextId is echoed back to the peer in the A2A response; the adapter itself
  // does not use it. We preserve what the peer sent (or mint a UUID if absent).
  contextId: string;
  // Peer-assigned message id, if any. Forwarded to the channel notification meta
  // so Claude can correlate the reply with the peer's original log line.
  messageId: string | null;
  text: string;
};

export type StartHttpOpts = {
  port: number;
  host: string;
  registry: PendingRegistry;
  replyTimeoutMs: number;
  onInbound: (info: InboundInfo) => void;
};

// 64 KB of UTF-8 text. A2A messages are typed conversations, not file uploads,
// and this sits well below Claude's context budget. Claw-connect already caps
// request bodies via its own rate-limit + size checks; this is defense in depth
// against an authenticated-but-hostile peer trying to flood context.
export const MAX_TEXT_BYTES = 64 * 1024;

export async function startHttp(opts: StartHttpOpts) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/message\\:send", async (req: Request, res: Response) => {
    const msg = req.body?.message;
    const textPart = msg?.parts?.[0]?.text;
    if (typeof textPart !== "string") {
      res.status(400).json({ error: "message.parts[0].text is required" });
      return;
    }
    if (Buffer.byteLength(textPart, "utf8") > MAX_TEXT_BYTES) {
      res
        .status(413)
        .json({ error: `message text exceeds ${MAX_TEXT_BYTES} byte limit` });
      return;
    }

    const taskId = randomUUID();
    const contextId =
      typeof msg.contextId === "string" ? msg.contextId : randomUUID();
    const messageId = typeof msg.messageId === "string" ? msg.messageId : null;

    // randomUUID collisions are effectively impossible, but if register ever
    // throws for any reason, fail the request with a 500 rather than crash.
    let pending: Promise<string>;
    try {
      pending = opts.registry.register(taskId, opts.replyTimeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
      return;
    }

    // If claw-connect (or any upstream) aborts the HTTP connection before we
    // reply, reject the pending task so the registry doesn't leak entries and
    // any still-in-flight a2a_reply tool call surfaces a clear error.
    res.on("close", () => {
      if (!res.writableEnded) {
        opts.registry.reject(taskId, new Error("client aborted"));
      }
    });

    opts.onInbound({ taskId, contextId, messageId, text: textPart });

    try {
      const replyText = await pending;
      if (res.writableEnded) return;
      res.json({
        id: taskId,
        contextId,
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "response",
            parts: [{ kind: "text", text: replyText }],
          },
        ],
      });
    } catch (err) {
      if (res.writableEnded) return;
      const message = err instanceof Error ? err.message : String(err);
      res.status(504).json({
        id: taskId,
        contextId,
        status: { state: "failed", message },
      });
    }
  });

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
