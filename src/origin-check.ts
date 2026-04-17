/**
 * Origin/Host header validation for the local (loopback) interface.
 *
 * Blocks browser-originated drive-by requests (DNS rebinding, CSRF-style
 * attacks from visited pages) by requiring that callers either omit Origin
 * or present a localhost origin matching the daemon's port. The daemon
 * binds to 127.0.0.1 only, so the Host header must also be a local name.
 */

export function isOriginAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser clients
  if (origin === "null") return true; // file:// / data: contexts
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  return allowed.includes(origin);
}

export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const allowed = [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ];
  return allowed.includes(host);
}
