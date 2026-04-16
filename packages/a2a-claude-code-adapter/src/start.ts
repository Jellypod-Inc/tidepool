import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  loadAgentConfig,
  loadProxyConfig,
  listPeerHandles,
} from "./config.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendOutbound } from "./outbound.js";
import { createThreadStore } from "./thread-store.js";

export type StartOpts = {
  configDir: string;
  agentName?: string;
  host?: string;
  maxMessagesPerThread?: number;
  maxThreads?: number;
  /** MCP transport for tests; defaults to stdio. */
  transport?: Transport;
};

export async function start(opts: StartOpts) {
  const host = opts.host ?? "127.0.0.1";

  const agent = loadAgentConfig(opts.configDir, opts.agentName);
  const proxy = loadProxyConfig(opts.configDir);

  const store = createThreadStore({
    maxMessagesPerThread: opts.maxMessagesPerThread ?? 200,
    maxThreads: opts.maxThreads ?? 100,
  });

  const channel = createChannel({
    self: agent.agentName,
    store,
    listPeers: () => listPeerHandles(opts.configDir, agent.agentName),
    send: ({ peer, contextId, text, participants }) =>
      sendOutbound({
        peer,
        contextId,
        text,
        self: agent.agentName,
        participants,
        deps: { localPort: proxy.localPort, host },
      }),
  });

  const emitInbound = (info: InboundInfo): void => {
    channel.notifyInbound(info).catch((err) => {
      process.stderr.write(
        `[claw-connect-adapter] notifyInbound failed: ${String(err)}\n`,
      );
    });
  };

  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  const http = await startHttp({
    port: agent.port,
    host,
    onInbound: emitInbound,
  });

  return {
    agent,
    close: async () => {
      await http.close();
      await channel.server.close();
    },
  };
}
