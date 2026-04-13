import express from "express";

interface DirectoryEntry {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  fingerprint: string;
  status: "online" | "offline";
  lastSeen: number;
  registeredAt: number;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;

export class DirectoryStore {
  private entries = new Map<string, DirectoryEntry>();

  register(
    handle: string,
    description: string,
    endpoint: string,
    agentCardUrl: string,
    fingerprint: string,
  ): DirectoryEntry | { error: string; status: number } {
    const existing = this.entries.get(handle);
    if (existing && existing.fingerprint !== fingerprint) {
      return { error: "Handle already registered by a different agent", status: 403 };
    }

    const now = Date.now();
    const entry: DirectoryEntry = {
      handle,
      description,
      endpoint,
      agentCardUrl,
      fingerprint,
      status: "online",
      lastSeen: now,
      registeredAt: existing?.registeredAt ?? now,
    };

    this.entries.set(handle, entry);
    return entry;
  }

  heartbeat(handle: string, fingerprint: string): DirectoryEntry | { error: string; status: number } {
    const entry = this.entries.get(handle);
    if (!entry) {
      return { error: "Agent not registered", status: 404 };
    }

    if (entry.fingerprint !== fingerprint) {
      return { error: "Fingerprint mismatch", status: 403 };
    }

    entry.lastSeen = Date.now();
    entry.status = "online";
    return entry;
  }

  search(query?: string, status?: string): DirectoryEntry[] {
    let results = Array.from(this.entries.values());

    const now = Date.now();
    for (const entry of results) {
      if (now - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        entry.status = "offline";
      }
    }

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (e) =>
          e.handle.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }

    if (status) {
      results = results.filter((e) => e.status === status);
    }

    return results;
  }

  getByHandle(handle: string): DirectoryEntry | null {
    const entry = this.entries.get(handle) ?? null;
    if (entry) {
      if (Date.now() - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        entry.status = "offline";
      }
    }
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createDirectoryApp(): { app: express.Application; store: DirectoryStore } {
  const app = express();
  app.use(express.json());

  const store = new DirectoryStore();

  function getFingerprint(req: express.Request): string | null {
    return (req.headers["x-client-fingerprint"] as string) ?? null;
  }

  app.post("/v1/agents/register", (req, res) => {
    const fingerprint = getFingerprint(req);
    if (!fingerprint) {
      res.status(401).json({ error: "No client certificate or fingerprint header" });
      return;
    }

    const { handle, description, endpoint, agentCardUrl } = req.body;
    if (!handle || !description || !endpoint || !agentCardUrl) {
      res.status(400).json({ error: "Missing required fields: handle, description, endpoint, agentCardUrl" });
      return;
    }

    const result = store.register(handle, description, endpoint, agentCardUrl, fingerprint);

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(201).json(toPublic(result));
  });

  app.get("/v1/agents/search", (req, res) => {
    const q = req.query.q as string | undefined;
    const status = req.query.status as string | undefined;

    const results = store.search(q, status);
    res.json({ agents: results.map(toPublic) });
  });

  app.get("/v1/agents/:handle", (req, res) => {
    const entry = store.getByHandle(req.params.handle);
    if (!entry) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(toPublic(entry));
  });

  app.post("/v1/agents/heartbeat", (req, res) => {
    const fingerprint = getFingerprint(req);
    if (!fingerprint) {
      res.status(401).json({ error: "No client certificate or fingerprint header" });
      return;
    }

    const { handle } = req.body;
    if (!handle) {
      res.status(400).json({ error: "Missing required field: handle" });
      return;
    }

    const result = store.heartbeat(handle, fingerprint);

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(toPublic(result));
  });

  return { app, store };
}

function toPublic(entry: DirectoryEntry): {
  handle: string;
  description: string;
  endpoint: string;
  agentCardUrl: string;
  status: string;
} {
  return {
    handle: entry.handle,
    description: entry.description,
    endpoint: entry.endpoint,
    agentCardUrl: entry.agentCardUrl,
    status: entry.status,
  };
}
