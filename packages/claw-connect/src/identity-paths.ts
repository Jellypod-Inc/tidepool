import path from "path";

export function peerCertPath(configDir: string): string {
  return path.join(configDir, "identity.crt");
}

export function peerKeyPath(configDir: string): string {
  return path.join(configDir, "identity.key");
}
