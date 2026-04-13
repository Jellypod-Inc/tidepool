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
