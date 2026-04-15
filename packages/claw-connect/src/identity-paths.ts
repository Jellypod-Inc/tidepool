import path from "path";
import fs from "fs";
import { getFingerprint } from "./identity.js";

export function peerCertPath(configDir: string): string {
  return path.join(configDir, "identity.crt");
}

export function peerKeyPath(configDir: string): string {
  return path.join(configDir, "identity.key");
}

export function readPeerFingerprint(configDir: string): string {
  const certPath = peerCertPath(configDir);
  if (!fs.existsSync(certPath)) {
    throw new Error(
      `Peer identity not found at ${certPath}. Run 'claw-connect init' first.`,
    );
  }
  const pem = fs.readFileSync(certPath, "utf-8");
  return getFingerprint(pem);
}
