import express from "express";
import type { ConfigHolder } from "../config-holder.js";
import { DASHBOARD_CSS } from "./style.js";
import { HTMX_JS } from "./vendor.js";
import { renderLayout } from "./layout.js";
import { renderHomePage, type HomeContext } from "./pages/home.js";
import { renderFriendsPage, renderFriendsTable, handleAddFriend, handleRemoveFriend } from "./pages/friends.js";
import { renderThreadsPage, renderThreadsTable } from "./pages/threads.js";
import { renderConfigPage, renderConfigContent, handleOpenFile, handleOpenDir } from "./pages/config.js";
import { renderAuditPage } from "./pages/audit.js";
import type { MessageLog } from "./message-log.js";

export { MessageLog } from "./message-log.js";

export function mountDashboard(
  app: express.Application,
  holder: ConfigHolder,
  configDir: string,
  messageLog: MessageLog,
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

  app.get("/dashboard/friends", (req, res) => {
    page("friends", "Friends", renderFriendsPage(holder), req, res);
  });

  app.get("/dashboard/friends/table", (_req, res) => {
    res.send(renderFriendsTable(holder.friends()));
  });

  // Body parsing for dashboard form submissions (url-encoded)
  const formParser = express.urlencoded({ extended: false });

  app.post("/dashboard/friends", formParser, (req, res) => {
    handleAddFriend(req, res, holder, configDir);
  });

  app.delete("/dashboard/friends/:handle", (req, res) => {
    handleRemoveFriend(req, res, holder, configDir);
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
}
