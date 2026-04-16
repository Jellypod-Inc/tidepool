import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  loadAgentConfig,
  loadProxyConfig,
  listPeerHandles,
} from "./config.js";
import { PendingRegistry } from "./pending.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendOutbound } from "./outbound.js";

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
  const proxy = loadProxyConfig(opts.configDir);
  const registry = new PendingRegistry();

  const emitInbound = (info: InboundInfo): void => {
    channel.notifyInbound(info).catch((err) => {
      process.stderr.write(
        `[claw-connect-adapter] notifyInbound failed: ${String(err)}\n`,
      );
    });
  };

  const channel = createChannel({
    registry,
    self: agent.agentName,
    listPeers: () => listPeerHandles(opts.configDir, agent.agentName),
    send: (peer, text) =>
      sendOutbound({
        peer,
        text,
        deps: {
          localPort: proxy.localPort,
          host,
          onReply: emitInbound,
        },
      }),
  });

  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    registry,
    replyTimeoutMs,
    onInbound: emitInbound,
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
