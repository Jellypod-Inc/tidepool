import fs from "fs";
import path from "path";

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

export function renderConfigContent(configDir: string): string {
  const files = ["server.toml", "friends.toml", "remotes.toml"];

  return files.map((name) => {
    const content = readFileOrEmpty(path.join(configDir, name));
    return `
      <h2>${name}</h2>
      <pre>${escapeHtml(content)}</pre>`;
  }).join("");
}

export function renderConfigPage(configDir: string): string {
  return `
    <h1>Config</h1>
    <button hx-post="/dashboard/config/reload" hx-target="#config-content" hx-swap="innerHTML" class="primary">
      Reload
    </button>
    <div id="config-content">
      ${renderConfigContent(configDir)}
    </div>
  `;
}
