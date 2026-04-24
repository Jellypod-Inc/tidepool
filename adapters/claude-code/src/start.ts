import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadAgentConfig, loadProxyConfig } from "./config.js";
import { startHttp, type InboundInfo } from "./http.js";
import { createChannel } from "./channel.js";
import { sendBroadcast } from "./outbound.js";
import { createThreadStore } from "./thread-store.js";
import { openSession } from "./session-client.js";
import { fetchPeers } from "./peers-client.js";

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

  // Session token populated after SSE registration; threaded into outbound deps.
  const sessionBox: { id: string } = { id: "" };

  const daemonUrl = `http://${host}:${proxy.localPort}`;

  const channel = createChannel({
    self: agent.agentName,
    store,
    listPeers: async () => {
      const peers = await fetchPeers(daemonUrl, agent.agentName);
      return peers.map((p) => p.handle);
    },
    broadcast: ({ peers, text, thread, addressed_to, in_reply_to }) =>
      sendBroadcast({
        peers,
        text,
        thread,
        addressed_to,
        in_reply_to,
        deps: { localPort: proxy.localPort, host, sessionId: sessionBox.id },
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

  // Open the SSE session to register our endpoint; the stream is liveness-only
  const session = await openSession({
    daemonUrl,
    name: agent.agentName,
    endpoint: inboundEndpoint,
    card: {
      description: "",
      skills: [{ id: "chat", name: "chat" }],
      capabilities: { streaming: false, extensions: [] },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    },
  });
  sessionBox.id = session.sessionId;

  return {
    agent,
    port: httpServer.port,
    close: async () => {
      await session.close();
      await httpServer.close();
      await channel.server.close();
    },
  };
}
