import type { RemoteAgent } from "./types.js";

export function mapLocalTenantToRemote(
  remoteAgents: RemoteAgent[],
  localHandle: string,
): RemoteAgent | null {
  return remoteAgents.find((r) => r.localHandle === localHandle) ?? null;
}

export function buildOutboundUrl(
  remoteEndpoint: string,
  remoteTenant: string,
  path: string,
): string {
  const base = remoteEndpoint.replace(/\/$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}/${remoteTenant}${cleanPath}`;
}
