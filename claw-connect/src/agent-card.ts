import type { RemoteAgent } from "./types.js";

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  securitySchemes: Record<string, unknown>;
  securityRequirements: Record<string, unknown[]>[];
}

interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

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
      stateTransitionHistory: false,
    },
    securitySchemes: {
      mtls: {
        mutualTlsSecurityScheme: {
          description:
            "mTLS with self-signed certificates. Identity is cert fingerprint.",
        },
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

export async function fetchRemoteAgentCard(
  url: string,
): Promise<AgentCard | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;

    if (!data.name || !data.url) return null;

    return data as AgentCard;
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
      stateTransitionHistory: false,
    },
    securitySchemes: {},
    securityRequirements: [],
  };
}
