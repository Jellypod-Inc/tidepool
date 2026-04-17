import type { Request, Response } from "express";
import type { FriendsConfig } from "../../types.js";
import type { ConfigHolder } from "../../config-holder.js";
import { addFriend, removeFriend, writeFriendsConfig } from "../../friends.js";
import path from "path";

function truncateFingerprint(fp: string): string {
  const prefix = fp.slice(0, 15);
  return `${prefix}…`;
}

export function renderFriendsTable(config: FriendsConfig): string {
  const entries = Object.entries(config.friends);

  if (entries.length === 0) {
    return `
      <table id="friends-table">
        <thead>
          <tr><th>Handle</th><th>Fingerprint</th><th>Scope</th><th>Actions</th></tr>
        </thead>
        <tbody>
          <tr><td colspan="4" class="placeholder">No friends yet</td></tr>
        </tbody>
      </table>
    `;
  }

  const rows = entries
    .map(([handle, entry]) => {
      const scope =
        entry.agents && entry.agents.length > 0
          ? entry.agents.join(", ")
          : "all agents";
      return `
        <tr>
          <td>${handle}</td>
          <td><span class="fingerprint" data-full="${entry.fingerprint}">${truncateFingerprint(entry.fingerprint)}</span></td>
          <td>${scope}</td>
          <td>
            <button
              hx-delete="/dashboard/friends/${handle}"
              hx-target="#friends-table"
              hx-swap="outerHTML"
              hx-confirm="Remove ${handle}?">
              Remove
            </button>
          </td>
        </tr>`;
    })
    .join("");

  return `
    <table id="friends-table"
      hx-get="/dashboard/friends/table"
      hx-trigger="every 5s"
      hx-swap="outerHTML">
      <thead>
        <tr><th>Handle</th><th>Fingerprint</th><th>Scope</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

export function renderFriendsPage(holder: ConfigHolder): string {
  const config = holder.friends();

  return `
    <h1>Friends</h1>

    <h2>Add Friend</h2>
    <form
      hx-post="/dashboard/friends"
      hx-target="#friends-table"
      hx-swap="outerHTML"
      hx-on::after-request="this.reset()">
      <label>
        Handle
        <input type="text" name="handle" required placeholder="alice" />
      </label>
      <label>
        Fingerprint
        <input type="text" name="fingerprint" required placeholder="sha256:…" />
      </label>
      <label>
        Agents (optional, comma-separated)
        <input type="text" name="agents" placeholder="code-review, search" />
      </label>
      <button type="submit">Add</button>
    </form>

    <h2>Friends</h2>
    ${renderFriendsTable(config)}
  `;
}

export function handleAddFriend(
  req: Request,
  res: Response,
  holder: ConfigHolder,
  configDir: string,
): void {
  const { handle, fingerprint, agents: agentsRaw } = req.body as {
    handle?: string;
    fingerprint?: string;
    agents?: string;
  };

  if (!handle || !fingerprint) {
    res.status(400).send("handle and fingerprint are required");
    return;
  }

  const agentsList: string[] | undefined =
    agentsRaw && agentsRaw.trim()
      ? agentsRaw
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
      : undefined;

  try {
    const updated = addFriend(holder.friends(), {
      handle,
      fingerprint,
      agents: agentsList,
    });

    writeFriendsConfig(path.join(configDir, "friends.toml"), updated);
    res.send(renderFriendsTable(updated));
  } catch (err) {
    res.status(400).send(String(err));
  }
}

export function handleRemoveFriend(
  req: Request,
  res: Response,
  holder: ConfigHolder,
  configDir: string,
): void {
  const { handle } = req.params;

  try {
    const updated = removeFriend(holder.friends(), handle);
    writeFriendsConfig(path.join(configDir, "friends.toml"), updated);
    res.send(renderFriendsTable(updated));
  } catch (err) {
    res.status(400).send(String(err));
  }
}
