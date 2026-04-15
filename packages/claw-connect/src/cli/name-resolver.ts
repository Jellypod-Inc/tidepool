import fs from "fs";
import path from "path";
import crypto from "crypto";
import { uniqueNamesGenerator, animals } from "unique-names-generator";
import type { ServerConfig } from "../types.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_RETRIES = 5;

export interface ResolveAgentNameOpts {
  cwd: string;
  serverConfig: ServerConfig;
  explicit?: string;
  rng?: () => string;
}

export async function resolveAgentName(opts: ResolveAgentNameOpts): Promise<string> {
  if (opts.explicit !== undefined) {
    if (!NAME_PATTERN.test(opts.explicit)) {
      throw new Error(
        `Agent name "${opts.explicit}" is not valid. Use lowercase letters, digits, and hyphens; start with a letter.`,
      );
    }
    return opts.explicit;
  }

  const fromMcp = readAgentFromMcpJson(path.join(opts.cwd, ".mcp.json"));
  if (fromMcp !== null) return fromMcp;

  const rng = opts.rng ?? (() => uniqueNamesGenerator({ dictionaries: [animals] }));
  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = rng();
    if (!(candidate in opts.serverConfig.agents)) return candidate;
  }

  const last = rng();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${last}-${suffix}`;
}

function readAgentFromMcpJson(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  const a2a = (parsed as { mcpServers?: { a2a?: { args?: unknown[] } } })?.mcpServers?.a2a;
  if (!a2a || !Array.isArray(a2a.args)) return null;
  const idx = a2a.args.indexOf("--agent");
  if (idx < 0 || idx + 1 >= a2a.args.length) return null;
  const next = a2a.args[idx + 1];
  return typeof next === "string" ? next : null;
}
