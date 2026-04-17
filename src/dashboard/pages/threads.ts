import type { MessageLog } from "../message-log.js";

function truncateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export function renderThreadsTable(messageLog: MessageLog): string {
  const threads = messageLog.list();

  if (threads.length === 0) {
    return `<div id="threads-table" hx-get="/dashboard/threads/table" hx-trigger="every 5s" hx-swap="outerHTML">
      <p class="placeholder">No threads yet — send a message through the mesh to see activity here</p>
    </div>`;
  }

  const rows = threads.map((t) => `
    <tr>
      <td title="${t.contextId}">${truncateId(t.contextId)}</td>
      <td>${t.participants.join(", ")}</td>
      <td>${t.messageCount}</td>
      <td>${formatTime(t.firstSeen)}</td>
      <td>${formatTime(t.lastActivity)}</td>
    </tr>`).join("");

  return `
    <div id="threads-table" hx-get="/dashboard/threads/table" hx-trigger="every 5s" hx-swap="outerHTML">
      <table>
        <thead>
          <tr><th>Context</th><th>Participants</th><th>Messages</th><th>Started</th><th>Last activity</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function renderThreadsPage(messageLog: MessageLog): string {
  return `
    <h1>Threads</h1>
    ${renderThreadsTable(messageLog)}
  `;
}
