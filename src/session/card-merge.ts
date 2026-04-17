import type { AgentCardFragment, AgentCardTransport } from "../types.js";

/**
 * Merge a daemon-owned transport envelope with an adapter-supplied fragment
 * to produce the A2A agent card that remote peers see.
 *
 * Transport fields (name, url, security, version, provider) always come
 * from the daemon — a malicious fragment cannot forge identity-adjacent
 * fields. The adapter contributes agent-semantic fields (description,
 * skills, capabilities, I/O modes, iconUrl, documentationUrl).
 */
export function mergeAgentCard(
  transport: AgentCardTransport,
  fragment: AgentCardFragment,
): Record<string, unknown> {
  return {
    name: transport.name,
    description: fragment.description ?? "",
    url: `${transport.publicUrl}/${transport.tenant}`,
    version: transport.version ?? "1.0.0",
    provider: transport.provider ?? { organization: "tidepool" },
    skills: fragment.skills ?? [],
    capabilities: {
      streaming: fragment.capabilities?.streaming ?? false,
      pushNotifications: fragment.capabilities?.pushNotifications ?? false,
      extensions: fragment.capabilities?.extensions ?? [],
    },
    defaultInputModes: fragment.defaultInputModes ?? ["text/plain"],
    defaultOutputModes: fragment.defaultOutputModes ?? ["text/plain"],
    securitySchemes: {},
    securityRequirements: [],
    ...(fragment.iconUrl ? { iconUrl: fragment.iconUrl } : {}),
    ...(fragment.documentationUrl ? { documentationUrl: fragment.documentationUrl } : {}),
  };
}
