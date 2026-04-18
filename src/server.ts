import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { buildPinnedDispatcher } from "./outbound-tls.js";
import { createConfigHolder, type ConfigHolder } from "./config-holder.js";
import {
  findPeerByFingerprint,
  checkAgentScope,
  resolveTenant,
  extractFingerprint,
  isConnectionRequest,
  extractConnectionMetadata,
  CONNECTION_EXTENSION_URL,
} from "./middleware.js";
import { mapLocalTenantToRemote, buildOutboundUrl } from "./proxy.js";
import { peerCertPath, peerKeyPath } from "./identity-paths.js";
import {
  buildLocalAgentCard,
  buildRemoteAgentCard,
  fetchRemoteAgentCard,
  buildRichRemoteAgentCard,
} from "./agent-card.js";
import { handleConnectionRequest } from "./handshake.js";
import { writePeersConfig } from "./peers/config.js";
import { projectHandles } from "./peers/resolve.js";
import { createDefaultThreadIndex, ThreadIndex } from "./thread-index.js";
import { BroadcastHandler, BroadcastValidationError, type DeliveryOutcome } from "./broadcast.js";
import { BroadcastRequestSchema } from "./schemas.js";
import { TokenBucket, parseRateLimit } from "./rate-limiter.js";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
  malformedRequestResponse,
  peerNotFoundResponse,
  unsupportedOperationResponse,
  structuredError,
  type A2AErrorResponse,
} from "./errors.js";
import { proxyUpstreamOrFail, initSSEResponse } from "./streaming.js";
import { buildFailedStatusEvent, MessageSchema } from "./a2a.js";
import { validateWire } from "./wire-validation.js";
import {
  injectMetadataFrom,
  stripMetadataFrom,
  resolveLocalHandleForRemoteSender,
} from "./identity-injection.js";
import type { RemoteAgent } from "./types.js";
import { mountDashboard, MessageLog } from "./dashboard/index.js";
import { MessageTap } from "./dashboard/message-tap.js";
import { isOriginAllowed, isHostAllowed } from "./origin-check.js";
import { originDeniedResponse } from "./errors.js";
import { createSessionRegistry, type SessionRegistry } from "./session/registry.js";
import { mountSessionEndpoint } from "./session/endpoint.js";
import { mergeAgentCard } from "./session/card-merge.js";
import { agentOfflineResponse } from "./errors.js";

function sendA2AError(res: express.Response, error: A2AErrorResponse): void {
  for (const [key, value] of Object.entries(error.headers)) {
    res.setHeader(key, value);
  }
  res.status(error.statusCode).json(error.body);
}

function makeOriginGuard(port: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.header("origin") ?? undefined;
    const host = req.header("host") ?? undefined;
    if (!isOriginAllowed(origin, port) || !isHostAllowed(host, port)) {
      const err = originDeniedResponse(origin ?? host ?? "<unknown>");
      res.status(err.statusCode).set(err.headers).json(err.body);
      return;
    }
    next();
  };
}

function mountTaskStubs(app: express.Application): void {
  const stub = (req: express.Request, res: express.Response) => {
    const method = `${req.method} ${req.route?.path ?? req.path}`;
    const msgId = req.body?.id ?? "";
    const err = unsupportedOperationResponse(method, msgId);
    res.status(err.statusCode).set(err.headers).json(err.body);
  };

  app.get("/:handle/tasks", stub);
  app.get("/:handle/tasks/:id", stub);
  app.post("/:handle/tasks/:id\\:cancel", stub);
}

export interface StartServerOpts {
  configDir: string;
  remoteAgents?: RemoteAgent[];
}

export async function startServer(opts: StartServerOpts) {
  const holder = createConfigHolder(opts.configDir);
  const initialServer = holder.server();
  const remoteAgents = opts.remoteAgents ?? [];

  // Server-wide rate limit uses the rateLimit config as of server start.
  // Per-agent buckets are created lazily in getOrCreateAgentBucket so that
  // agents registered *after* the daemon started also get a bucket.
  const serverRateConfig = parseRateLimit(initialServer.server.rateLimit);
  const serverBucket = new TokenBucket(
    serverRateConfig.tokens,
    serverRateConfig.windowMs,
  );

  const agentBuckets = new Map<string, TokenBucket>();
  const getOrCreateAgentBucket = (name: string): TokenBucket | null => {
    const existing = agentBuckets.get(name);
    if (existing) return existing;
    const cfg = holder.server().agents[name];
    if (!cfg) return null;
    const parsed = parseRateLimit(cfg.rateLimit);
    const bucket = new TokenBucket(parsed.tokens, parsed.windowMs);
    agentBuckets.set(name, bucket);
    return bucket;
  };

  const messageLog = new MessageLog(200);
  const messageTap = new MessageTap(50);
  const startedAt = new Date();
  const sessionRegistry = createSessionRegistry();
  const threadIndex = createDefaultThreadIndex();

  // Public interface: mTLS
  const tlsOpts = buildTlsOptions(opts.configDir);

  const publicServer = https.createServer(tlsOpts);
  const localServer = http.createServer();

  await new Promise<void>((resolve) => {
    publicServer.listen(initialServer.server.port, initialServer.server.host, () => resolve());
  });
  await new Promise<void>((resolve) => {
    localServer.listen(initialServer.server.localPort, "127.0.0.1", () => resolve());
  });

  const localPort = (localServer.address() as { port: number }).port;

  const publicApp = createPublicApp(
    holder,
    opts.configDir,
    serverBucket,
    getOrCreateAgentBucket,
    remoteAgents,
    messageLog,
    messageTap,
    sessionRegistry,
  );
  // Graceful shutdown — closes listeners and stops config watcher. Exposed
  // via POST /internal/shutdown so `tidepool stop` can terminate the daemon
  // without relying on pidfile lookups or OS signals.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await new Promise<void>((resolve) => publicServer.close(() => resolve()));
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
    holder.stop();
    // Give the HTTP response a tick to flush, then exit so the parent process
    // observes port release promptly.
    setTimeout(() => process.exit(0), 50).unref();
  };

  const localApp = createLocalApp(holder, remoteAgents, opts.configDir, messageLog, messageTap, startedAt, localPort, sessionRegistry, shutdown, threadIndex);

  publicServer.on("request", publicApp);
  localServer.on("request", localApp);

  console.log(
    `Public interface: https://${initialServer.server.host}:${initialServer.server.port}`,
  );
  console.log(
    `Local interface: http://127.0.0.1:${localPort} (adapters register via SSE session; senders pass X-Session-Id)`,
  );
  console.log(
    `Dashboard: http://127.0.0.1:${localPort}/dashboard`,
  );

  return {
    publicServer,
    localServer,
    sessionRegistry,
    close: () => {
      publicServer.close();
      localServer.close();
      holder.stop();
    },
  };
}

function buildTlsOptions(configDir: string) {
  const certPath = peerCertPath(configDir);
  const keyPath = peerKeyPath(configDir);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      `Peer identity not found at ${certPath}. Run 'tidepool init' first.`,
    );
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    requestCert: true,
    rejectUnauthorized: false, // We verify fingerprints manually (self-signed certs)
  };
}

// --- Public interface (mTLS, for remote peers) ---

function createPublicApp(
  holder: ConfigHolder,
  configDir: string,
  serverBucket: TokenBucket,
  getOrCreateAgentBucket: (name: string) => TokenBucket | null,
  remoteAgents: RemoteAgent[],
  messageLog: MessageLog,
  messageTap: MessageTap,
  sessionRegistry: SessionRegistry,
): express.Application {
  const app = express();
  app.use(express.json());

  // Serializes concurrent connection-request approvals so two requests can't
  // both derive the same handle or race peers.toml writes. deriveHandle reads
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
      const config = holder.server();
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

  // Stub out tasks/* endpoints with UnsupportedOperationError
  mountTaskStubs(app);

  // A2A proxy endpoint per tenant — full middleware pipeline
  app.post(
    "/:tenant/:action",
    async (req, res) => {
      const config = holder.server();
      const { tenant, action } = req.params;
      // Caller's messageId — threaded into every error response so clients
      // can correlate failures to the request that triggered them. May be
      // undefined for malformed bodies; error builders fall back to a uuid.
      const messageId: string | undefined = req.body?.message?.messageId;

      // --- Step 0: Validate inbound A2A message envelope ---
      const inbound = validateWire(
        MessageSchema,
        req.body?.message,
        { mode: config.validation.mode, context: "inbound.public.message" },
      );
      if (!inbound.ok) {
        sendA2AError(res, malformedRequestResponse(inbound.error, messageId));
        return;
      }

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

      // --- Step 3: Resolve inbound trust via peers.toml ---
      const peers = holder.peers();
      const peerLookup = findPeerByFingerprint(peers, peerFingerprint);

      if (!peerLookup) {
        // Not a peer or friend — check if this is a CONNECTION_REQUEST
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
              const peersPath = `${configDir}/peers.toml`;
              const currentPeers = holder.peers();
              const r = await handleConnectionRequest({
                config: config.connectionRequests,
                peers: currentPeers,
                writePeers: (cfg) => writePeersConfig(peersPath, cfg),
                fingerprint: peerFingerprint,
                endpoint: new URL(metadata.agentCardUrl).origin,
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

      // --- Step 4: Resolve tenant via session registry ---
      // Instead of resolving the agent config, look up the active session.
      // Falls back to agentNotFoundResponse when no adapter is currently registered
      // for this handle, preserving the A2A envelope shape remote peers expect.
      const session = sessionRegistry.get(tenant);
      if (!session) {
        sendA2AError(res, agentNotFoundResponse(tenant, messageId));
        return;
      }

      // --- Step 5: Agent rate limit ---
      const agentBucket = getOrCreateAgentBucket(tenant);
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
      // peerEntry.agents is informational (used for outbound routing), not an inbound ACL;
      // treat an empty list as "all agents allowed" to match the peers.toml intent.
      if (!checkAgentScope({ agents: undefined }, tenant)) {
        sendA2AError(res, agentScopeDeniedResponse(tenant, messageId));
        return;
      }

      const contextId: string | undefined = req.body?.message?.contextId;
      messageLog.record({ contextId, agent: tenant });
      const inboundSenderAgent = req.header("x-sender-agent") ?? "unknown";
      messageTap.emit({
        direction: "inbound",
        from: `${peerLookup.handle}/${inboundSenderAgent}`,
        to: tenant,
        action,
        message: req.body?.message,
      });

      // --- Step 6.5: Translate remote sender agent → local handle ---
      // The wire carries the remote tenant name in X-Sender-Agent; the local
      // agent needs the local handle assigned to that (peer, agent) pair so
      // metadata.from is authoritative and symmetric with local→local flows.
      const senderAgentName = req.header("x-sender-agent");
      if (!senderAgentName) {
        res.status(400).json({ error: "X-Sender-Agent header required" });
        return;
      }
      const localHandle = resolveLocalHandleForRemoteSender(
        remoteAgents,
        peerFingerprint,
        senderAgentName,
      );
      if (!localHandle) {
        res.status(403).json({ error: "unknown remote sender agent" });
        return;
      }

      // --- Step 7: Forward to registered session endpoint ---
      const targetUrl = `${session.endpoint}/${action}`;
      const timeoutSeconds = config.agents[tenant]?.timeoutSeconds ?? 30;
      const timeoutMs = timeoutSeconds * 1000;

      // Streaming branch
      if (action === "message:stream") {
        const streamTimeoutMs = config.server.streamTimeoutSeconds * 1000;
        const taskId = req.body?.message?.messageId ?? uuidv4();

        try {
          const upstreamResponse = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(injectMetadataFrom(req.body, localHandle)),
          });

          await proxyUpstreamOrFail({
            upstreamResponse,
            downstream: res,
            timeoutMs: streamTimeoutMs,
            taskId,
            validationMode: config.validation.mode,
          });
        } catch {
          if (!res.headersSent) {
            sendA2AError(
              res,
              agentTimeoutResponse(tenant, timeoutSeconds, messageId),
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
          body: JSON.stringify(injectMetadataFrom(req.body, localHandle)),
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
            agentTimeoutResponse(tenant, timeoutSeconds, messageId),
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
  holder: ConfigHolder,
  remoteAgents: RemoteAgent[],
  configDir: string,
  messageLog: MessageLog,
  messageTap: MessageTap,
  startedAt: Date,
  port: number,
  sessionRegistry: SessionRegistry,
  shutdown: () => Promise<void>,
  threadIndex: ThreadIndex,
): express.Application {
  const app = express();
  app.use(express.json());
  app.use(makeOriginGuard(port));   // Apply origin guard to ALL local routes

  // Lifecycle endpoint — loopback + origin-guarded; used by `tidepool stop`.
  app.post("/internal/shutdown", (_req, res) => {
    res.status(202).json({ status: "shutting-down" });
    void shutdown();
  });

  // Dashboard routes must be registered before /:tenant/:action to avoid
  // the parameterized route matching /dashboard/* paths.
  mountDashboard(app, holder, configDir, messageLog, messageTap, startedAt);

  mountSessionEndpoint(app, {
    registry: sessionRegistry,
    port,
  });

  // --- Delivery helpers (shared by legacy endpoints and broadcast handler) ---

  /**
   * Deliver a non-streaming message:send to a local agent via its session endpoint.
   * Returns DeliveryOutcome (never throws).
   */
  async function deliverToLocalAgent(
    agentName: string,
    messageBody: unknown,
  ): Promise<DeliveryOutcome> {
    const session = sessionRegistry.get(agentName);
    if (!session) {
      return {
        delivery: "failed",
        reason: {
          kind: "peer-not-registered",
          message: `Agent "${agentName}" has no active session`,
          hint: "Ensure the agent's adapter is running and has opened a session.",
        },
      };
    }
    const targetUrl = `${session.endpoint}/message:send`;
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageBody),
      });
      if (response.ok) {
        return { delivery: "accepted" };
      }
      const text = await response.text().catch(() => "");
      return {
        delivery: "failed",
        reason: {
          kind: "other",
          message: `Agent endpoint returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
        },
      };
    } catch (err) {
      return {
        delivery: "failed",
        reason: {
          kind: "peer-unreachable",
          message: err instanceof Error ? err.message : "Local agent unreachable",
        },
      };
    }
  }

  /**
   * Deliver a non-streaming message:send to a remote peer via mTLS.
   * Returns DeliveryOutcome (never throws).
   */
  async function deliverToRemotePeer(
    peerName: string,
    agentName: string,
    messageBody: unknown,
  ): Promise<DeliveryOutcome> {
    const peers = holder.peers();
    const peerEntry = peers.peers[peerName];
    if (!peerEntry) {
      return {
        delivery: "failed",
        reason: {
          kind: "peer-not-registered",
          message: `Peer "${peerName}" not found in peers.toml`,
        },
      };
    }
    const targetUrl = buildOutboundUrl(peerEntry.endpoint, agentName, "/message:send");
    const certPath = peerCertPath(configDir);
    const keyPath = peerKeyPath(configDir);
    try {
      const dispatcher = buildPinnedDispatcher(certPath, keyPath, peerEntry.fingerprint ?? "");
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageBody),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher,
      });
      if (response.ok) {
        return { delivery: "accepted" };
      }
      const text = await response.text().catch(() => "");
      return {
        delivery: "failed",
        reason: {
          kind: "other",
          message: `Remote peer returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
        },
      };
    } catch (err) {
      return {
        delivery: "failed",
        reason: {
          kind: "peer-unreachable",
          message: err instanceof Error ? err.message : "Remote peer unreachable",
        },
      };
    }
  }

  // --- Broadcast endpoint ---
  const broadcastHandler = new BroadcastHandler({
    peers: () => holder.peers(),
    // used by broadcast handler to include local agents in handle resolution
    localAgents: () => {
      const agentSet = new Set<string>();
      for (const name of Object.keys(holder.server().agents)) agentSet.add(name);
      for (const sess of sessionRegistry.list()) agentSet.add(sess.name);
      return Array.from(agentSet);
    },
    threadIndex,
    deliverRemote: (peerName, agentName, body) =>
      deliverToRemotePeer(peerName, agentName, body),
    deliverLocal: (agentName, body) => deliverToLocalAgent(agentName, body),
  });

  // POST /message:broadcast — must be registered BEFORE the generic /:peer/:agent/:action
  // and /:tenant/:action catches so this path matches first.
  app.post("/message\\:broadcast", async (req, res) => {
    const sessionId = req.header("x-session-id");
    if (!sessionId) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id header required",
        "Open a session via POST /.well-known/tidepool/agents/<name>/session and pass the returned sessionId as X-Session-Id on subsequent requests.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }
    const session = sessionRegistry.getBySessionId(sessionId);
    if (!session) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id does not match any active session",
        "The session may have been closed. Re-open via POST /.well-known/tidepool/agents/<name>/session.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }

    const parsed = BroadcastRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "invalid_body", detail: parsed.error.issues });
      return;
    }

    try {
      const result = await broadcastHandler.run({
        senderAgent: session.name,
        ...parsed.data,
      });
      res.status(200).json(result);
    } catch (e) {
      if (e instanceof BroadcastValidationError) {
        res.status(400).json({ code: e.code, detail: e.detail });
        return;
      }
      throw e;
    }
  });

  // Tidepool extensions (origin guard is now global, no per-route guard needed).
  // Peers = friended remotes ∪ live local sessions on this daemon. Locality is
  // opaque to the caller: same-daemon siblings are implicitly trusted because
  // the trust boundary is the daemon itself. `?self=<handle>` filters the caller out.
  app.get("/.well-known/tidepool/peers", (req, res) => {
    const selfRaw = req.query.self;
    const self = typeof selfRaw === "string" ? selfRaw : undefined;

    // Local agents = server.toml agent keys ∪ live session names (minus self)
    const localAgentSet = new Set<string>();
    for (const name of Object.keys(holder.server().agents)) {
      if (name !== self) localAgentSet.add(name);
    }
    for (const sess of sessionRegistry.list()) {
      if (sess.name !== self) localAgentSet.add(sess.name);
    }
    const localAgents = Array.from(localAgentSet);

    // Project peers.toml agents + local agents into minimally-unambiguous handles
    const peersCfg = holder.peers();
    const projected = projectHandles(peersCfg, localAgents);

    const unique = Array.from(new Set(projected)).sort();
    res.json(unique.map((handle) => ({ handle, did: null as string | null })));
  });

  // Root Agent Card listing all available agents (local + remote)
  app.get("/.well-known/agent-card.json", (_req, res) => {
    const config = holder.server();
    const allAgents = [
      ...Object.keys(config.agents),
      ...remoteAgents.map((r) => r.localHandle),
    ];

    res.json({
      name: "tidepool",
      description: `Tidepool proxy. Available agents: ${allAgents.join(", ")}`,
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

  // Per-tenant Agent Card
  app.get("/:tenant/.well-known/agent-card.json", async (req, res) => {
    const config = holder.server();
    const { tenant } = req.params;

    // 1. If a session is registered for this handle, build a merged card
    const session = sessionRegistry.get(tenant);
    if (session) {
      const publicUrl = `http://127.0.0.1:${port}`;
      const card = mergeAgentCard(
        { name: tenant, publicUrl, tenant },
        session.card,
      );
      res.json(card);
      return;
    }

    // 2. If a remote agent, fetch and enrich (existing behavior)
    const remote = mapLocalTenantToRemote(remoteAgents, tenant);
    if (remote) {
      const agentCardUrl = `${remote.remoteEndpoint}/${remote.remoteTenant}/.well-known/agent-card.json`;
      const remoteCard = await fetchRemoteAgentCard(agentCardUrl);
      const card = buildRichRemoteAgentCard({
        remote,
        localUrl: `http://127.0.0.1:${port}`,
        remoteCard,
      });
      res.json(card);
      return;
    }

    // 3. Neither session nor remote → agent offline
    const err = agentOfflineResponse(tenant);
    res.status(err.statusCode).json(err.body);
  });

  // Stub out tasks/* endpoints with UnsupportedOperationError.
  // Registered BEFORE /:peer/:agent/:action so /handle/tasks/:id:cancel is
  // never swallowed by the scoped outbound route.
  mountTaskStubs(app);

  // Scoped outbound proxy — routes /peer/agent/:action via peers.toml.
  // Registered AFTER mountTaskStubs but BEFORE the generic /:tenant/:action
  // handler so 3-segment paths like /bob/writer/message:send are matched here.
  app.post("/:peer/:agent/:action", async (req, res) => {
    const config = holder.server();
    const { peer: peerName, agent: agentName, action } = req.params;

    // --- Authenticate the sender via their active session ---
    const sessionId = req.header("x-session-id");
    if (!sessionId) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id header required",
        "Open a session via POST /.well-known/tidepool/agents/<name>/session and pass the returned sessionId as X-Session-Id on subsequent requests.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }
    const senderSession = sessionRegistry.getBySessionId(sessionId);
    if (!senderSession) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id does not match any active session",
        "The session may have been closed. Re-open via POST /.well-known/tidepool/agents/<name>/session.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }
    const senderAgent = senderSession.name;

    // --- Lookup peer in peers.toml ---
    const peers = holder.peers();
    const peerEntry = peers.peers[peerName];
    if (!peerEntry) {
      const peerErr = peerNotFoundResponse(peerName);
      res.status(peerErr.statusCode).set(peerErr.headers).json(peerErr.body);
      return;
    }

    // --- Verify the agent is in the peer's advertised agent list ---
    if (!peerEntry.agents.includes(agentName)) {
      const err = structuredError(
        404,
        "agent_not_found",
        `Peer "${peerName}" has no agent "${agentName}"`,
        `Known agents for this peer: ${peerEntry.agents.join(", ") || "(none)"}`,
      );
      res.status(err.statusCode).json(err.body);
      return;
    }

    // --- Validate outbound A2A message ---
    const inbound = validateWire(
      MessageSchema,
      req.body?.message,
      { mode: config.validation.mode, context: "outbound.scoped.message" },
    );
    if (!inbound.ok) {
      sendA2AError(res, malformedRequestResponse(inbound.error, req.body?.message?.messageId));
      return;
    }

    const contextId: string | undefined = req.body?.message?.contextId;
    messageLog.record({ contextId, agent: senderAgent });
    messageTap.emit({
      direction: "outbound",
      from: senderAgent,
      to: `${peerName}/${agentName}`,
      action,
      message: req.body?.message,
    });

    // Synthesise a RemoteAgent triplet from the peers.toml entry so we can
    // reuse the same mTLS outbound path.
    const synthRemote: RemoteAgent = {
      localHandle: peerName,
      remoteEndpoint: peerEntry.endpoint,
      remoteTenant: agentName,
      certFingerprint: peerEntry.fingerprint ?? "",
    };

    const targetUrl = buildOutboundUrl(
      synthRemote.remoteEndpoint,
      synthRemote.remoteTenant,
      `/${action}`,
    );

    const certPath = peerCertPath(configDir);
    const keyPath = peerKeyPath(configDir);
    const streamTimeoutMs = config.server.streamTimeoutSeconds * 1000;
    const isStream = action === "message:stream";

    try {
      const dispatcher = buildPinnedDispatcher(
        certPath,
        keyPath,
        synthRemote.certFingerprint,
      );

      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sender-Agent": senderAgent,
        },
        body: JSON.stringify(stripMetadataFrom(req.body)),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher,
      });

      if (isStream) {
        const taskId = req.body?.message?.messageId ?? uuidv4();
        await proxyUpstreamOrFail({
          upstreamResponse: response,
          downstream: res,
          timeoutMs: streamTimeoutMs,
          taskId,
          validationMode: config.validation.mode,
          nonStreamingMessage: "Remote agent returned non-streaming response",
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

  // Outbound proxy — local agent sends A2A to a remote agent via local handle
  app.post("/:tenant/:action", async (req, res) => {
    const config = holder.server();
    const { tenant, action } = req.params;

    // Fast-path: if the handle is neither a known local agent nor a remote
    // agent, return peer_not_found immediately (before checking X-Agent so the
    // caller gets the most helpful error).
    const isKnownLocal = !!config.agents[tenant];
    const isKnownRemote = !!mapLocalTenantToRemote(remoteAgents, tenant);
    if (!isKnownLocal && !isKnownRemote) {
      const peerErr = peerNotFoundResponse(tenant);
      res.status(peerErr.statusCode).set(peerErr.headers).json(peerErr.body);
      return;
    }

    // Authenticate the sender via their active session. Post-Task-19 adapters
    // send X-Session-Id (the sessionId returned from openSession). We look up
    // the session to recover the sender's agent name, which is then injected
    // as metadata.from on outbound messages.
    const sessionId = req.header("x-session-id");
    if (!sessionId) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id header required",
        "Open a session via POST /.well-known/tidepool/agents/<name>/session and pass the returned sessionId as X-Session-Id on subsequent requests.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }
    const senderSession = sessionRegistry.getBySessionId(sessionId);
    if (!senderSession) {
      const err = structuredError(
        403,
        "invalid_request",
        "X-Session-Id does not match any active session",
        "The session may have been closed. Re-open via POST /.well-known/tidepool/agents/<name>/session.",
      );
      res.status(err.statusCode).json(err.body);
      return;
    }
    const senderAgent = senderSession.name;

    const contextId: string | undefined = req.body?.message?.contextId;
    messageLog.record({ contextId, agent: senderAgent });
    messageTap.emit({
      direction: "outbound",
      from: senderAgent,
      to: tenant,
      action,
      message: req.body?.message,
    });

    const inbound = validateWire(
      MessageSchema,
      req.body?.message,
      { mode: config.validation.mode, context: "inbound.local.message" },
    );
    if (!inbound.ok) {
      sendA2AError(res, malformedRequestResponse(inbound.error, req.body?.message?.messageId));
      return;
    }

    const remote = mapLocalTenantToRemote(remoteAgents, tenant);
    const streamTimeoutMs = config.server.streamTimeoutSeconds * 1000;
    const isStream = action === "message:stream";

    if (!remote) {
      // Not a remote agent — forward to local agent via session registry endpoint.
      const session = sessionRegistry.get(tenant);
      if (!session) {
        // Agent is registered in config but no adapter has opened a session yet.
        res.status(503).json({
          status: { state: "failed" },
          artifacts: [
            {
              artifactId: "error",
              parts: [{ kind: "text", text: `Agent "${tenant}" is offline (no active session)` }],
            },
          ],
        });
        return;
      }
      const targetUrl = `${session.endpoint}/${action}`;

      if (isStream) {
        const taskId = req.body?.message?.messageId ?? uuidv4();
        try {
          const upstreamResponse = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(injectMetadataFrom(req.body, senderAgent)),
          });

          await proxyUpstreamOrFail({
            upstreamResponse,
            downstream: res,
            timeoutMs: streamTimeoutMs,
            taskId,
            validationMode: config.validation.mode,
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
          body: JSON.stringify(injectMetadataFrom(req.body, senderAgent)),
        });
        const data = await response.json();
        res.status(response.status).json(data);
      } catch {
        res.status(504).json({ error: "Local agent unreachable" });
      }
      return;
    }

    // Build outbound URL
    const targetUrl = buildOutboundUrl(
      remote.remoteEndpoint,
      remote.remoteTenant,
      `/${action}`,
    );

    // Outbound mTLS authenticates as this peer. All agents share the peer's
    // identity on the wire; agents are tenants, not wire-level identities.
    const certPath = peerCertPath(configDir);
    const keyPath = peerKeyPath(configDir);

    try {
      const dispatcher = buildPinnedDispatcher(
        certPath,
        keyPath,
        remote.certFingerprint,
      );

      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sender-Agent": senderAgent,
        },
        body: JSON.stringify(stripMetadataFrom(req.body)),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher,
      });

      if (isStream) {
        const taskId = req.body?.message?.messageId ?? uuidv4();
        await proxyUpstreamOrFail({
          upstreamResponse: response,
          downstream: res,
          timeoutMs: streamTimeoutMs,
          taskId,
          validationMode: config.validation.mode,
          nonStreamingMessage: "Remote agent returned non-streaming response",
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
