export type Peer = { handle: string; did: string | null };

export async function fetchPeers(
  daemonUrl: string,
  self?: string,
): Promise<Peer[]> {
  const url = self
    ? `${daemonUrl}/.well-known/tidepool/peers?self=${encodeURIComponent(self)}`
    : `${daemonUrl}/.well-known/tidepool/peers`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `fetchPeers: HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error("fetchPeers: expected JSON array from /peers");
  }
  return json as Peer[];
}
