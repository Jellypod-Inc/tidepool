import fs from "fs";
import path from "path";

export interface EnsureMcpJsonOpts {
  cwd: string;
  agentName: string;
}

export type EnsureMcpJsonResult =
  | { action: "created"; previousAgent: null }
  | { action: "updated"; previousAgent: string | null }
  | { action: "unchanged"; previousAgent: string };

const ADAPTER_COMMAND = "a2a-claude-code-adapter";
const MCP_SERVER_KEY = "claw-connect";

export async function ensureMcpJsonEntry(
  opts: EnsureMcpJsonOpts,
): Promise<EnsureMcpJsonResult> {
  const filePath = path.join(opts.cwd, ".mcp.json");
  const desiredArgs = ["--agent", opts.agentName];

  if (!fs.existsSync(filePath)) {
    const fresh = {
      mcpServers: {
        [MCP_SERVER_KEY]: { command: ADAPTER_COMMAND, args: desiredArgs },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2) + "\n");
    return { action: "created", previousAgent: null };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`.mcp.json can't be parsed: ${msg}. Fix or remove it and rerun.`);
  }

  const mcpServers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  // Back-compat: if the old "a2a" key exists, drop it in favor of "claw-connect".
  const legacy = mcpServers["a2a"] as { command?: string; args?: unknown[] } | undefined;
  const existing =
    (mcpServers[MCP_SERVER_KEY] as { command?: string; args?: unknown[] } | undefined) ??
    legacy;
  const previousAgent = extractAgent(existing?.args);

  const alreadyCorrect =
    !legacy &&
    existing?.command === ADAPTER_COMMAND &&
    Array.isArray(existing?.args) &&
    existing!.args!.length === desiredArgs.length &&
    existing!.args!.every((v, i) => v === desiredArgs[i]);

  if (alreadyCorrect && previousAgent !== null) {
    return { action: "unchanged", previousAgent };
  }

  if (legacy) delete mcpServers["a2a"];
  mcpServers[MCP_SERVER_KEY] = { command: ADAPTER_COMMAND, args: desiredArgs };
  parsed.mcpServers = mcpServers;
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n");

  return { action: "updated", previousAgent };
}

function extractAgent(args: unknown[] | undefined): string | null {
  if (!Array.isArray(args)) return null;
  const idx = args.indexOf("--agent");
  if (idx < 0 || idx + 1 >= args.length) return null;
  const v = args[idx + 1];
  return typeof v === "string" ? v : null;
}
