import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";

export type A2APart =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: unknown; metadata?: Record<string, unknown> }
  | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };

export type InboundInfo = {
  taskId: string;
  contextId: string;
  messageId: string;
  peer: string;
  participants: string[];
  parts: A2APart[];
  text: string; // first text part, or empty string — kept for convenience
};

export type StartHttpOpts = {
  port: number;
  host: string;
  onInbound: (info: InboundInfo) => void;
};

export const MAX_TEXT_BYTES = 64 * 1024;

function parseParticipants(raw: unknown, fallbackPeer: string): string[] {
  if (!Array.isArray(raw)) return [fallbackPeer];
  const clean = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (clean.length === 0) return [fallbackPeer];
  return clean;
}

export async function startHttp(opts: StartHttpOpts) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Stub out tasks/* endpoints with UnsupportedOperationError (A2A JSON-RPC shape).
  const stub = (req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32006,
        message: `Operation not supported: ${req.method} ${req.path}`,
      },
      id: req.body?.id ?? "",
    });
  };
  app.get("/tasks", stub);
  app.get("/tasks/:id", stub);
  app.post("/tasks/:id\\:cancel", stub);

  // Express path encoding: ":" must be escaped in route definition.
  app.post("/message\\:send", async (req: Request, res: Response) => {
    const msg = req.body?.message;
    if (!msg) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const parts: A2APart[] = Array.isArray(msg.parts) ? msg.parts : [];
    const textPart = parts.find((p) => p.kind === "text") as
      | { kind: "text"; text: string }
      | undefined;
    const text = textPart?.text ?? "";

    if (Buffer.byteLength(JSON.stringify(parts), "utf8") > MAX_TEXT_BYTES) {
      res
        .status(413)
        .json({ error: `message parts exceed ${MAX_TEXT_BYTES} byte limit` });
      return;
    }

    const peer =
      typeof msg?.metadata?.from === "string" ? msg.metadata.from : null;
    if (!peer) {
      res.status(400).json({ error: "message.metadata.from is required" });
      return;
    }

    const participants = parseParticipants(msg?.metadata?.participants, peer);

    const taskId = randomUUID();
    const contextId =
      typeof msg.contextId === "string" ? msg.contextId : randomUUID();
    const messageId = typeof msg.messageId === "string" ? msg.messageId : taskId;

    // Emit synchronously before responding; if onInbound throws, log and ack
    // anyway — the message is "received" from the wire's perspective.
    try {
      opts.onInbound({
        taskId,
        contextId,
        messageId,
        peer,
        participants,
        parts,
        text,
      });
    } catch (err) {
      process.stderr.write(
        `[tidepool-adapter] onInbound threw: ${String(err)}\n`,
      );
    }

    res.json({
      id: taskId,
      contextId,
      status: { state: "completed" },
    });
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
