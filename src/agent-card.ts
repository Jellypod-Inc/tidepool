import {
  AgentCardSchema,
  declareExtension,
} from "./a2a.js";
import type { AgentCard } from "./a2a.js";
import { CONNECTION_EXTENSION_URL } from "./middleware.js";
import type { RemoteAgent } from "./types.js";

export type { AgentCard };

interface BuildLocalOpts {
  name: string;
  description: string;
  publicUrl: string;
  tenant: string;
}

export function buildLocalAgentCard(opts: BuildLocalOpts): AgentCard {
  return {
    name: opts.name,
    description: opts.description,
    url: `${opts.publicUrl}/${opts.tenant}`,
    version: "1.0.0",
    skills: [
      {
        id: "chat",
        name: "chat",
        description: opts.description,
        tags: [],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [
        declareExtension(CONNECTION_EXTENSION_URL, {
          description: "Tidepool peer friending handshake",
          required: false,
        }),
      ],
    },
    securitySchemes: {
      mtls: {
        type: "mtls",
        description: "mTLS with self-signed certificates. Identity is cert fingerprint.",
      },
    },
    securityRequirements: [{ mtls: [] }],
  };
}

interface BuildRemoteOpts {
  remote: RemoteAgent;
  localUrl: string;
  description: string;
}

/**
 * Fetch a peer's Agent Card over plain HTTPS with no fingerprint pinning.
 *
 * Initial card discovery happens BEFORE the peer's fingerprint is known
 * (the card itself is what you use to decide whether to friend them).
 * Pinning here would be chicken-and-egg. Post-friending interactions — A2A
 * messages and any authenticated card refresh — go through
 * buildPinnedDispatcher, which does enforce fingerprint equality.
 */
export async function fetchRemoteAgentCard(
  url: string,
): Promise<AgentCard | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();

    const parsed = AgentCardSchema.safeParse(data);
    if (!parsed.success) return null;

    return parsed.data as unknown as AgentCard;
  } catch {
    return null;
  }
}

interface BuildRichRemoteOpts {
  remote: RemoteAgent;
  localUrl: string;
  remoteCard: AgentCard | null;
}

export function buildRichRemoteAgentCard(opts: BuildRichRemoteOpts): AgentCard {
  const { remote, localUrl, remoteCard } = opts;

  if (!remoteCard) {
    return buildRemoteAgentCard({
      remote,
      localUrl,
      description: `Remote agent: ${remote.localHandle}`,
    });
  }

  return {
    name: remote.localHandle,
    description: remoteCard.description,
    url: `${localUrl}/${remote.localHandle}`,
    version: remoteCard.version,
    skills: remoteCard.skills,
    defaultInputModes: remoteCard.defaultInputModes,
    defaultOutputModes: remoteCard.defaultOutputModes,
    capabilities: remoteCard.capabilities,
    // The local interface is plain HTTP on 127.0.0.1 — local agents talk to
    // their own Tidepool without credentials. We deliberately drop the
    // remote card's mTLS scheme so local agents don't try to present client
    // certs when calling localhost. mTLS happens server-to-server on the
    // public interface, handled transparently by the Tidepool proxy.
    securitySchemes: {},
    securityRequirements: [],
  };
}

export function buildRemoteAgentCard(opts: BuildRemoteOpts): AgentCard {
  return {
    name: opts.remote.localHandle,
    description: opts.description,
    url: `${opts.localUrl}/${opts.remote.localHandle}`,
    version: "1.0.0",
    skills: [
      {
        id: "chat",
        name: "chat",
        description: opts.description,
        tags: [],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    securitySchemes: {},
    securityRequirements: [],
  };
}
