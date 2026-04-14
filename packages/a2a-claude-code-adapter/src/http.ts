import express, { Request, Response } from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { PendingRegistry } from "./pending.js";

export type InboundInfo = {
  taskId: string;
  contextId: string;
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

    const taskId = randomUUID();
    const contextId =
      typeof msg.contextId === "string" ? msg.contextId : randomUUID();
    const messageId = typeof msg.messageId === "string" ? msg.messageId : null;

    const pending = opts.registry.register(taskId, opts.replyTimeoutMs);
    opts.onInbound({ taskId, contextId, messageId, text: textPart });

    try {
      const replyText = await pending;
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

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
