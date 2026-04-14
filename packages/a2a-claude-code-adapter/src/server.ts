import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

type Pending = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  contextId: string;
};

export type StartOptions = {
  port: number;
  host?: string;
  replyTimeoutMs?: number;
};

export function start(opts: StartOptions) {
  const host = opts.host ?? "127.0.0.1";
  const replyTimeoutMs = opts.replyTimeoutMs ?? 10 * 60_000;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const pending = new Map<string, Pending>();

  const logInbound = (record: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ type: "inbound", ...record }) + "\n");
  };

  app.post("/message\\:send", (req: Request, res: Response) => {
    const msg = req.body?.message;
    const text = msg?.parts?.[0]?.text ?? "";
    const taskId = randomUUID();
    const contextId = msg?.contextId ?? randomUUID();

    logInbound({
      taskId,
      contextId,
      messageId: msg?.messageId,
      role: msg?.role,
      text,
      instruction: `reply via: curl -X POST http://${host}:${opts.port}/__control/reply/${taskId} -H 'Content-Type: application/json' -d '{"text":"..."}'`,
    });

    const timeout = setTimeout(() => {
      const p = pending.get(taskId);
      if (!p) return;
      pending.delete(taskId);
      res.status(504).json({
        id: taskId,
        contextId,
        status: { state: "failed", message: "reply timeout" },
      });
    }, replyTimeoutMs);

    pending.set(taskId, {
      contextId,
      timeout,
      resolve: (replyText: string) => {
        clearTimeout(timeout);
        pending.delete(taskId);
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
      },
      reject: (err: Error) => {
        clearTimeout(timeout);
        pending.delete(taskId);
        if (!res.headersSent) {
          res.status(500).json({
            id: taskId,
            contextId,
            status: { state: "failed", message: err.message },
          });
        }
      },
    });
  });

  app.post("/__control/reply/:taskId", (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const text = String(req.body?.text ?? "");
    const p = pending.get(taskId);
    if (!p) {
      res.status(404).json({ error: "unknown taskId" });
      return;
    }
    p.resolve(text);
    res.json({ ok: true, taskId });
  });

  app.get("/__control/pending", (_req: Request, res: Response) => {
    res.json({
      pending: [...pending.keys()].map((taskId) => ({
        taskId,
        contextId: pending.get(taskId)?.contextId,
      })),
    });
  });

  const server = app.listen(opts.port, host, () => {
    process.stderr.write(
      `claude-code-agent listening on http://${host}:${opts.port}\n`,
    );
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const p of pending.values()) p.reject(new Error("shutdown"));
        server.close(() => resolve());
      }),
  };
}
