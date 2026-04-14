import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { buildPinnedDispatcher } from "./outbound-tls.js";
import { loadServerConfig, loadFriendsConfig } from "./config.js";
import {
  checkFriend,
  checkAgentScope,
  resolveTenant,
  extractFingerprint,
  isConnectionRequest,
  extractConnectionMetadata,
  CONNECTION_EXTENSION_URL,
} from "./middleware.js";
import { mapLocalTenantToRemote, buildOutboundUrl } from "./proxy.js";
import {
  buildLocalAgentCard,
  buildRemoteAgentCard,
  fetchRemoteAgentCard,
  buildRichRemoteAgentCard,
} from "./agent-card.js";
import { handleConnectionRequest } from "./handshake.js";
import { addFriend, writeFriendsConfig } from "./friends.js";
import { TokenBucket, parseRateLimit } from "./rate-limiter.js";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
  type A2AErrorResponse,
} from "./errors.js";
import { proxySSEStream, initSSEResponse } from "./streaming.js";
import { buildFailedStatusEvent } from "./a2a.js";
import type { RemoteAgent, ServerConfig, FriendsConfig } from "./types.js";

function sendA2AError(res: express.Response, error: A2AErrorResponse): void {
  for (const [key, value] of Object.entries(error.headers)) {
    res.setHeader(key, value);
  }
  res.status(error.statusCode).json(error.body);
}

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

  // Initialize rate limiters
  const serverRateConfig = parseRateLimit(serverConfig.server.rateLimit);
  const serverBucket = new TokenBucket(
    serverRateConfig.tokens,
    serverRateConfig.windowMs,
  );

  const agentBuckets = new Map<string, TokenBucket>();
  for (const [name, agentConfig] of Object.entries(serverConfig.agents)) {
    const agentRateConfig = parseRateLimit(agentConfig.rateLimit);
    agentBuckets.set(
      name,
      new TokenBucket(agentRateConfig.tokens, agentRateConfig.windowMs),
    );
  }

  const publicApp = createPublicApp(
    serverConfig,
    friendsConfig,
    opts.configDir,
    serverBucket,
    agentBuckets,
  );
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
  configDir: string,
  serverBucket: TokenBucket,
  agentBuckets: Map<string, TokenBucket>,
): express.Application {
  const app = express();
  app.use(express.json());

  // Serializes concurrent connection-request approvals so two requests can't
  // both derive the same handle or race friends.toml writes. deriveHandle reads
  // in-memory state which is only safe when mutations are serialized.
  let handshakeChain: Promise<unknown> = Promise.resolve();
  const runSerial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = handshakeChain.then(() => fn());
    handshakeChain = next.catch(() => undefined);
    return next;
  };

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

  // A2A proxy endpoint per tenant — full middleware pipeline
  app.post(
    "/:tenant/:action",
    async (req, res) => {
      const { tenant, action } = req.params;
      // Caller's messageId — threaded into every error response so clients
      // can correlate failures to the request that triggered them. May be
      // undefined for malformed bodies; error builders fall back to a uuid.
      const messageId: string | undefined = req.body?.message?.messageId;

      // --- Step 1: Server rate limit ---
      const serverResult = serverBucket.consume();
      if (!serverResult.allowed) {
        sendA2AError(
          res,
          rateLimitResponse(serverResult.retryAfterSeconds, messageId),
        );
        return;
      }

      // --- Step 2: Extract peer cert fingerprint ---
      const peerCert = (req.socket as any).getPeerCertificate?.();
      const peerFingerprint = extractFingerprint(peerCert?.raw);
      if (!peerFingerprint) {
        sendA2AError(res, notFriendResponse(messageId));
        return;
      }

      // --- Step 3: Check friends list ---
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        // Not a friend — check if this is a CONNECTION_REQUEST
        if (isConnectionRequest(req.body, req.headers)) {
          const metadata = extractConnectionMetadata(
            req.body as Record<string, unknown>,
          );
          if (!metadata) {
            res.status(400).json({ error: "Malformed connection request" });
            return;
          }

          try {
            const result = await runSerial(async () => {
              const r = await handleConnectionRequest({
                config: config.connectionRequests,
                friends,
                fingerprint: peerFingerprint,
                reason: metadata.reason,
                agentCardUrl: metadata.agentCardUrl,
                fetchAgentCard: async (url: string) => {
                  const card = await fetchRemoteAgentCard(url);
                  if (!card) {
                    throw new Error(`Unable to fetch peer agent card at ${url}`);
                  }
                  return { name: card.name };
                },
                pendingRequestsPath: `${configDir}/pending-requests.json`,
              });

              if (r.newFriend) {
                const updated = addFriend(friends, {
                  handle: r.newFriend.handle,
                  fingerprint: r.newFriend.fingerprint,
                });
                friends.friends = updated.friends;
                writeFriendsConfig(`${configDir}/friends.toml`, updated);
              }
              return r;
            });

            res.setHeader("X-A2A-Extensions", CONNECTION_EXTENSION_URL);
            res.json(result.response);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Handshake failed";
            res.status(500).json({ error: message });
          }
          return;
        }

        sendA2AError(res, notFriendResponse(messageId));
        return;
      }

      // --- Step 4: Resolve tenant ---
      const agent = resolveTenant(config, tenant);
      if (!agent) {
        sendA2AError(res, agentNotFoundResponse(tenant, messageId));
        return;
      }

      // --- Step 5: Agent rate limit ---
      const agentBucket = agentBuckets.get(tenant);
      if (agentBucket) {
        const agentResult = agentBucket.consume();
        if (!agentResult.allowed) {
          sendA2AError(
            res,
            rateLimitResponse(agentResult.retryAfterSeconds, messageId),
          );
          return;
        }
      }

      // --- Step 6: Check agent scope ---
      if (!checkAgentScope(friendLookup.friend, tenant)) {
        sendA2AError(res, agentScopeDeniedResponse(tenant, messageId));
        return;
      }

      // --- Step 7: Forward to local agent ---
      const targetUrl = `${agent.localEndpoint}/${action}`;
      const timeoutMs = agent.timeoutSeconds * 1000;

      // Streaming branch
      if (action === "message:stream") {
        const streamTimeoutMs = config.server.streamTimeoutSeconds * 1000;
        const taskId = req.body?.message?.messageId ?? uuidv4();

        try {
          const upstreamResponse = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
          });

          if (!upstreamResponse.ok || !upstreamResponse.body) {
            const sse = initSSEResponse(res);
            sse.write(buildFailedStatusEvent(taskId, `ctx-${taskId}`, "Agent returned non-streaming response"));
            sse.end();
            return;
          }

          await proxySSEStream({
            upstreamResponse,
            downstream: res,
            timeoutMs: streamTimeoutMs,
            taskId,
            contextId: `ctx-${taskId}`,
          });
        } catch {
          if (!res.headersSent) {
            sendA2AError(
              res,
              agentTimeoutResponse(tenant, agent.timeoutSeconds, messageId),
            );
          }
        }
        return;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const data = await response.json();
        res.status(response.status).json(data);
      } catch (err) {
        // Only report as timeout if the abort fired. Other errors (ECONNREFUSED,
        // invalid JSON, etc.) get a 504 with a more accurate message.
        if (err instanceof Error && err.name === "AbortError") {
          sendA2AError(
            res,
            agentTimeoutResponse(tenant, agent.timeoutSeconds, messageId),
          );
        } else {
          const message = err instanceof Error ? err.message : "Agent unreachable";
          res.status(504).json({
            id: messageId ?? uuidv4(),
            status: { state: "failed" },
            artifacts: [
              { artifactId: "error", parts: [{ kind: "text", text: message }] },
            ],
          });
        }
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
      capabilities: { streaming: true, pushNotifications: false },
      securitySchemes: {},
      securityRequirements: [],
    });
  });

  // Per-tenant Agent Card (remote agents)
  app.get("/:tenant/.well-known/agent-card.json", async (req, res) => {
    const { tenant } = req.params;
    const remote = mapLocalTenantToRemote(remoteAgents, tenant);

    if (remote) {
      // Try to fetch the remote agent's actual Agent Card for rich metadata
      const agentCardUrl = `${remote.remoteEndpoint}/${remote.remoteTenant}/.well-known/agent-card.json`;
      const remoteCard = await fetchRemoteAgentCard(agentCardUrl);

      const card = buildRichRemoteAgentCard({
        remote,
        localUrl: `http://127.0.0.1:${config.server.localPort}`,
        remoteCard,
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
    const streamTimeoutMs = config.server.streamTimeoutSeconds * 1000;
    const isStream = action === "message:stream";

    if (!remote) {
      // Not a remote agent — could be forwarding to local agent (passthrough)
      const agent = config.agents[tenant];
      if (agent) {
        const targetUrl = `${agent.localEndpoint}/${action}`;

        if (isStream) {
          const taskId = req.body?.message?.messageId ?? uuidv4();
          try {
            const upstreamResponse = await fetch(targetUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(req.body),
            });

            if (!upstreamResponse.ok || !upstreamResponse.body) {
              const sse = initSSEResponse(res);
              sse.write(buildFailedStatusEvent(taskId, `ctx-${taskId}`, "Agent returned non-streaming response"));
              sse.end();
              return;
            }

            await proxySSEStream({
              upstreamResponse,
              downstream: res,
              timeoutMs: streamTimeoutMs,
              taskId,
              contextId: `ctx-${taskId}`,
            });
          } catch {
            if (!res.headersSent) {
              res.status(504).json({ error: "Local agent unreachable" });
            }
          }
          return;
        }

        try {
          const response = await fetch(targetUrl, {
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
      const dispatcher = buildPinnedDispatcher(
        certPath,
        keyPath,
        remote.certFingerprint,
      );

      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher,
      });

      if (isStream) {
        const taskId = req.body?.message?.messageId ?? uuidv4();
        if (!response.ok || !response.body) {
          const sse = initSSEResponse(res);
          sse.write(buildFailedStatusEvent(taskId, `ctx-${taskId}`, "Remote agent returned non-streaming response"));
          sse.end();
          return;
        }

        await proxySSEStream({
          upstreamResponse: response,
          downstream: res,
          timeoutMs: streamTimeoutMs,
          taskId,
          contextId: `ctx-${taskId}`,
        });
        return;
      }

      const data = await response.json();
      res.status(response.status).json(data);
    } catch {
      if (isStream && !res.headersSent) {
        const taskId = req.body?.message?.messageId ?? uuidv4();
        const sse = initSSEResponse(res);
        sse.write(buildFailedStatusEvent(taskId, `ctx-${taskId}`, "Remote agent unreachable"));
        sse.end();
        return;
      }
      res.status(504).json({
        id: uuidv4(),
        status: { state: "failed" },
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
