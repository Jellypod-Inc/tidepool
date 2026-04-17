import express from "express";
import type { ConfigHolder } from "../config-holder.js";
import { DASHBOARD_CSS } from "./style.js";
import { HTMX_JS } from "./vendor.js";
import { renderLayout } from "./layout.js";
import { renderHomePage, type HomeContext } from "./pages/home.js";
import { renderThreadsPage, renderThreadsTable } from "./pages/threads.js";
import { renderConfigPage, renderConfigContent, handleOpenFile, handleOpenDir } from "./pages/config.js";
import { renderAuditPage } from "./pages/audit.js";
import type { MessageLog } from "./message-log.js";
import type { MessageTap, TapEvent } from "./message-tap.js";

export { MessageLog } from "./message-log.js";
export { MessageTap } from "./message-tap.js";

export function mountDashboard(
  app: express.Application,
  holder: ConfigHolder,
  configDir: string,
  messageLog: MessageLog,
  messageTap: MessageTap,
  startedAt: Date,
): void {
  // Static assets
  app.get("/dashboard/style.css", (_req, res) => {
    res.type("text/css").send(DASHBOARD_CSS);
  });

  app.get("/dashboard/htmx.min.js", (_req, res) => {
    res.type("application/javascript").send(HTMX_JS);
  });

  // Helper: if htmx request, send just the content; otherwise full layout.
  const page = (
    activePage: Parameters<typeof renderLayout>[0]["activePage"],
    title: string,
    content: string,
    req: express.Request,
    res: express.Response,
  ) => {
    if (req.headers["hx-request"]) {
      res.send(content);
    } else {
      res.send(renderLayout({ title, activePage, content }));
    }
  };

  // --- Pages ---

  app.get("/dashboard", (req, res) => {
    const ctx: HomeContext = { holder, configDir, startedAt };
    page("home", "Home", renderHomePage(ctx), req, res);
  });

  app.get("/dashboard/threads", (req, res) => {
    page("threads", "Threads", renderThreadsPage(messageLog), req, res);
  });

  app.get("/dashboard/threads/table", (_req, res) => {
    res.send(renderThreadsTable(messageLog));
  });

  app.get("/dashboard/config", (req, res) => {
    page("config", "Config", renderConfigPage(configDir), req, res);
  });

  app.post("/dashboard/config/reload", (_req, res) => {
    res.send(renderConfigContent(configDir));
  });

  app.post("/dashboard/config/open/:filename", (req, res) => {
    handleOpenFile(req, res, configDir);
  });

  app.post("/dashboard/config/open-dir", (_req, res) => {
    handleOpenDir(_req, res, configDir);
  });

  app.get("/dashboard/audit", (req, res) => {
    page("audit", "Audit", renderAuditPage(), req, res);
  });

  // Live message tail — SSE stream of inbound/outbound A2A messages crossing
  // this daemon. Consumed by `tidepool tail`. Origin guard already applies.
  app.get("/internal/tail", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (event: TapEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const past of messageTap.recent()) write(past);
    const unsubscribe = messageTap.subscribe(write);

    const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });
}
