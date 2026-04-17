import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import type express from "express";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(file not found)";
  }
}

const CONFIG_FILES = ["server.toml", "peers.toml"];

export function renderConfigContent(configDir: string): string {
  return CONFIG_FILES.map((name) => {
    const content = readFileOrEmpty(path.join(configDir, name));
    return `
      <h2>${name}
        <button hx-post="/dashboard/config/open/${name}" hx-swap="none" style="margin-left: 8px; font-size: 12px;">
          Open in editor
        </button>
      </h2>
      <pre>${escapeHtml(content)}</pre>`;
  }).join("");
}

export function renderConfigPage(configDir: string): string {
  return `
    <h1>Config</h1>
    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button hx-post="/dashboard/config/reload" hx-target="#config-content" hx-swap="innerHTML" class="primary">
        Reload
      </button>
      <button hx-post="/dashboard/config/open-dir" hx-swap="none">
        Open config directory
      </button>
    </div>
    <div id="config-content">
      ${renderConfigContent(configDir)}
    </div>
  `;
}

function openInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL;
  const cmd = editor ?? (process.platform === "darwin" ? "open" : "xdg-open");
  const child = spawn(cmd, [filePath], { detached: true, stdio: "ignore" });
  child.unref();
}

export function handleOpenFile(
  req: express.Request,
  res: express.Response,
  configDir: string,
): void {
  const raw = req.params.filename;
  const filename = Array.isArray(raw) ? raw[0] : raw;
  if (!filename || !CONFIG_FILES.includes(filename)) {
    res.status(400).send("Invalid file");
    return;
  }
  openInEditor(path.join(configDir, filename));
  res.status(204).send();
}

export function handleOpenDir(
  _req: express.Request,
  res: express.Response,
  configDir: string,
): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [configDir], { detached: true, stdio: "ignore" });
  child.unref();
  res.status(204).send();
}
