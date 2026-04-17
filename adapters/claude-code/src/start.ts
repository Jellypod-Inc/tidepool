import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadAgentConfig, loadProxyConfig } from "./config.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendOutbound } from "./outbound.js";
import { createThreadStore } from "./thread-store.js";
import { openSession, type Peer } from "./session-client.js";

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

  // Mutable peer list populated by SSE snapshots
  const peersBox: { current: Peer[] } = { current: [] };
  // Session token populated after SSE registration; threaded into outbound deps.
  const sessionBox: { id: string } = { id: "" };

  const channel = createChannel({
    self: agent.agentName,
    store,
    listPeers: () => peersBox.current.map((p) => p.handle),
    send: ({ peer, contextId, text, participants }) =>
      sendOutbound({
        peer,
        contextId,
        text,
        self: agent.agentName,
        participants,
        deps: { localPort: proxy.localPort, host, sessionId: sessionBox.id || undefined },
      }),
  });

  const emitInbound = (info: InboundInfo): void => {
    channel.notifyInbound(info).catch((err) => {
      process.stderr.write(
        `[tidepool-adapter] notifyInbound failed: ${String(err)}\n`,
      );
    });
  };

  const transport = opts.transport ?? new StdioServerTransport();
  await channel.server.connect(transport);

  // Bind the HTTP inbound server first so we know our endpoint URL
  const httpServer = await startHttp({
    port: agent.port ?? 0,
    host,
    onInbound: emitInbound,
  });

  const inboundEndpoint = `http://${host}:${httpServer.port}`;

  // Open the SSE session to register our endpoint and receive peer updates
  const session = await openSession({
    daemonUrl: `http://${host}:${proxy.localPort}`,
    name: agent.agentName,
    endpoint: inboundEndpoint,
    card: {
      description: "",
      skills: [{ id: "chat", name: "chat" }],
      capabilities: { streaming: false, extensions: [] },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    },
    onPeers: (peers) => {
      peersBox.current = peers;
    },
  });
  sessionBox.id = session.sessionId;

  return {
    agent,
    close: async () => {
      await session.close();
      await httpServer.close();
      await channel.server.close();
    },
  };
}
