import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { Agent } from "undici";
import { loadServerConfig, loadFriendsConfig } from "./config.js";
import { getFingerprint } from "./identity.js";
import { checkFriend, checkAgentScope, resolveTenant } from "./middleware.js";
import { mapLocalTenantToRemote, buildOutboundUrl } from "./proxy.js";
import { buildLocalAgentCard, buildRemoteAgentCard } from "./agent-card.js";
import type { RemoteAgent, ServerConfig, FriendsConfig } from "./types.js";

export interface StartServerOpts {
  configDir: string;
  remoteAgents?: RemoteAgent[];
}

export async function startServer(opts: StartServerOpts) {
  const serverConfig = loadServerConfig(
    `${opts.configDir}/server.toml`,
  );
  const friendsConfig = loadFriendsConfig(
    `${opts.configDir}/friends.toml`,
  );
  const remoteAgents = opts.remoteAgents ?? [];

  const publicApp = createPublicApp(serverConfig, friendsConfig);
  const localApp = createLocalApp(serverConfig, remoteAgents, opts.configDir);

  // Public interface: mTLS
  const agentNames = Object.keys(serverConfig.agents);
  const tlsOpts = buildTlsOptions(opts.configDir, agentNames);

  const publicServer = https.createServer(tlsOpts, publicApp);
  const localServer = http.createServer(localApp);

  await new Promise<void>((resolve) => {
    publicServer.listen(serverConfig.server.port, serverConfig.server.host, resolve);
  });
  await new Promise<void>((resolve) => {
    localServer.listen(serverConfig.server.localPort, "127.0.0.1", resolve);
  });

  console.log(
    `Public interface: https://${serverConfig.server.host}:${serverConfig.server.port}`,
  );
  console.log(
    `Local interface: http://127.0.0.1:${serverConfig.server.localPort}`,
  );

  return {
    publicServer,
    localServer,
    close: () => {
      publicServer.close();
      localServer.close();
    },
  };
}

function buildTlsOptions(configDir: string, agentNames: string[]) {
  const firstAgent = agentNames[0];
  if (!firstAgent) {
    throw new Error("No agents registered. Run 'claw-connect register' first.");
  }

  const certPath = `${configDir}/agents/${firstAgent}/identity.crt`;
  const keyPath = `${configDir}/agents/${firstAgent}/identity.key`;

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    requestCert: true,
    rejectUnauthorized: false, // We verify fingerprints manually (self-signed certs)
  };
}

// --- Public interface (mTLS, for remote peers) ---

function createPublicApp(
  config: ServerConfig,
  friends: FriendsConfig,
): express.Application {
  const app = express();
  app.use(express.json());

  // Agent Card endpoint per tenant
  app.get(
    "/:tenant/.well-known/agent-card.json",
    (req, res) => {
      const agent = resolveTenant(config, req.params.tenant);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const publicUrl = `https://${req.hostname}:${config.server.port}`;
      const card = buildLocalAgentCard({
        name: req.params.tenant,
        description: agent.description,
        publicUrl,
        tenant: req.params.tenant,
      });

      res.json(card);
    },
  );

  // A2A proxy endpoint per tenant — matches /:tenant/message:send etc.
  app.post(
    "/:tenant/:action",
    async (req, res) => {
      const { tenant, action } = req.params;

      // 1. Extract peer cert fingerprint
      const peerCert = (req.socket as any).getPeerCertificate?.();
      if (!peerCert || !peerCert.raw) {
        res.status(401).json({ error: "No client certificate" });
        return;
      }

      const peerFingerprint = getFingerprint(
        `-----BEGIN CERTIFICATE-----\n${peerCert.raw.toString("base64")}\n-----END CERTIFICATE-----`,
      );

      // 2. Check friends list
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        res.status(401).json({ error: "Not a friend" });
        return;
      }

      // 3. Resolve tenant
      const agent = resolveTenant(config, tenant);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // 4. Check agent scope
      if (!checkAgentScope(friendLookup.friend, tenant)) {
        res.status(403).json({ error: "Not authorized for this agent" });
        return;
      }

      // 5. Forward to local agent's A2A endpoint
      const targetUrl = `${agent.localEndpoint}/${action}`;

      try {
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });

        const data = await response.json();
        res.status(response.status).json(data);
      } catch {
        res.status(504).json({
          id: uuidv4(),
          status: { state: "TASK_STATE_FAILED" },
          artifacts: [
            {
              artifactId: "error",
              parts: [{ kind: "text", text: "Agent unreachable" }],
            },
          ],
        });
      }
    },
  );

  return app;
}

// --- Local interface (HTTP, for local agents) ---

function createLocalApp(
  config: ServerConfig,
  remoteAgents: RemoteAgent[],
  configDir: string,
): express.Application {
  const app = express();
  app.use(express.json());

  // Root Agent Card listing all available agents (local + remote)
  app.get("/.well-known/agent-card.json", (_req, res) => {
    const allAgents = [
      ...Object.keys(config.agents),
      ...remoteAgents.map((r) => r.localHandle),
    ];

    res.json({
      name: "claw-connect",
      description: `Claw Connect proxy. Available agents: ${allAgents.join(", ")}`,
      url: `http://127.0.0.1:${config.server.localPort}`,
      version: "1.0.0",
      skills: allAgents.map((name) => ({
        id: name,
        name,
        description:
          config.agents[name]?.description ??
          remoteAgents.find((r) => r.localHandle === name)?.localHandle ??
          name,
        tags: [],
      })),
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      securitySchemes: {},
      securityRequirements: [],
    });
  });

  // Per-tenant Agent Card (remote agents)
  app.get("/:tenant/.well-known/agent-card.json", (req, res) => {
    const { tenant } = req.params;
    const remote = mapLocalTenantToRemote(remoteAgents, tenant);

    if (remote) {
      const card = buildRemoteAgentCard({
        remote,
        localUrl: `http://127.0.0.1:${config.server.localPort}`,
        description: `Remote agent: ${remote.localHandle}`,
      });
      res.json(card);
      return;
    }

    // Could be a local agent
    const agent = config.agents[tenant];
    if (agent) {
      const card = buildLocalAgentCard({
        name: tenant,
        description: agent.description,
        publicUrl: `http://127.0.0.1:${config.server.localPort}`,
        tenant,
      });
      res.json(card);
      return;
    }

    res.status(404).json({ error: "Agent not found" });
  });

  // Outbound proxy — local agent sends A2A to a remote agent via local handle
  app.post("/:tenant/:action", async (req, res) => {
    const { tenant, action } = req.params;
    const remote = mapLocalTenantToRemote(remoteAgents, tenant);

    if (!remote) {
      // Not a remote agent — could be forwarding to local agent (passthrough)
      const agent = config.agents[tenant];
      if (agent) {
        try {
          const response = await fetch(`${agent.localEndpoint}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
          });
          const data = await response.json();
          res.status(response.status).json(data);
        } catch {
          res.status(504).json({ error: "Local agent unreachable" });
        }
        return;
      }

      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Build outbound URL
    const targetUrl = buildOutboundUrl(
      remote.remoteEndpoint,
      remote.remoteTenant,
      `/${action}`,
    );

    // Load the first registered agent's cert for mTLS
    const firstAgent = Object.keys(config.agents)[0];
    const certPath = `${configDir}/agents/${firstAgent}/identity.crt`;
    const keyPath = `${configDir}/agents/${firstAgent}/identity.key`;

    try {
      const dispatcher = new Agent({
        connect: {
          cert: fs.readFileSync(certPath, "utf-8"),
          key: fs.readFileSync(keyPath, "utf-8"),
          rejectUnauthorized: false,
        },
      });

      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher,
      });

      const data = await response.json();
      res.status(response.status).json(data);
    } catch {
      res.status(504).json({
        id: uuidv4(),
        status: { state: "TASK_STATE_FAILED" },
        artifacts: [
          {
            artifactId: "error",
            parts: [
              { kind: "text", text: "Remote agent unreachable" },
            ],
          },
        ],
      });
    }
  });

  return app;
}
