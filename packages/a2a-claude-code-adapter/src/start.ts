import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadAgentConfig } from "./config.js";
import { PendingRegistry } from "./pending.js";
import { startHttp } from "./http.js";
import { createChannel } from "./channel.js";

export type StartOpts = {
  configDir: string;
  agentName?: string;
  host?: string;
  replyTimeoutMs?: number;
  /**
   * Transport for the MCP server. Defaults to stdio (what Claude Code spawns).
   * Tests pass an in-memory transport.
   */
  transport?: Transport;
};

export async function start(opts: StartOpts) {
  const host = opts.host ?? "127.0.0.1";
  const replyTimeoutMs = opts.replyTimeoutMs ?? 10 * 60_000;

  const agent = loadAgentConfig(opts.configDir, opts.agentName);
  const registry = new PendingRegistry();
  const channel = createChannel({ registry, serverName: "a2a" });
  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    registry,
    replyTimeoutMs,
    onInbound: (info) => {
      // Fire-and-forget — the notification failing should not kill the process.
      channel.notifyInbound(info).catch((err) => {
        process.stderr.write(
          `[a2a-adapter] notifyInbound failed: ${String(err)}\n`,
        );
      });
    },
  });

  return {
    agent,
    close: async () => {
      registry.closeAll(new Error("adapter shutting down"));
      await http.close();
      await channel.server.close();
    },
  };
}
