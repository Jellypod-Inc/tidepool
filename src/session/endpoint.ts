import type { Express, Request, Response } from "express";
import { isOriginAllowed, isHostAllowed } from "../origin-check.js";
import { structuredError, originDeniedResponse, sessionConflictResponse } from "../errors.js";
import type { SessionRegistry } from "./registry.js";

export interface MountSessionOpts {
  registry: SessionRegistry;
  /** Daemon's local port; used for Origin/Host validation. */
  port: number;
}

export interface MountedSession {}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function mountSessionEndpoint(
  app: Express,
  opts: MountSessionOpts,
): MountedSession {
  app.post(
    "/.well-known/tidepool/agents/:name/session",
    (req: Request, res: Response) => {
      // --- Origin/Host check ---
      const origin = req.header("origin") ?? undefined;
      const host = req.header("host") ?? undefined;
      if (
        !isOriginAllowed(origin, opts.port) ||
        !isHostAllowed(host, opts.port)
      ) {
        const err = originDeniedResponse(origin ?? host ?? "<unknown>");
        res.status(err.statusCode).set(err.headers).json(err.body);
        return;
      }

      // --- Body validation ---
      const name = req.params.name as string;
      const endpoint = req.body?.endpoint;
      const card = req.body?.card;
      if (typeof endpoint !== "string" || !endpoint.startsWith("http://")) {
        const err = structuredError(
          400,
          "invalid_request",
          "body.endpoint is required and must be an http:// URL",
          "Ensure the adapter bound its inbound server and set endpoint to the resulting URL.",
        );
        res.status(err.statusCode).json(err.body);
        return;
      }
      if (card !== undefined && (typeof card !== "object" || Array.isArray(card))) {
        const err = structuredError(
          400,
          "invalid_request",
          "body.card must be an object if provided",
        );
        res.status(err.statusCode).json(err.body);
        return;
      }

      // --- Register ---
      const result = opts.registry.register(name, {
        endpoint,
        card: card ?? {},
      });
      if (!result.ok) {
        const err = sessionConflictResponse(name);
        res.status(err.statusCode).json(err.body);
        return;
      }

      // --- Open SSE ---
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders?.();

      writeEvent(res, "session.registered", { sessionId: result.session.sessionId });

      const keepalive = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          // cleanup handled below
        }
      }, 15_000);

      // Use res.on("close") which fires when the underlying TCP socket is closed,
      // not when the request body stream is exhausted (which req.on("close") does).
      res.on("close", () => {
        clearInterval(keepalive);
        opts.registry.deregister(result.session.sessionId);
      });
    },
  );

  return {};
}
