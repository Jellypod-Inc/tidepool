import forge from "node-forge";
import fs from "fs";
import path from "path";
import type { AgentIdentity } from "./types.js";

interface GenerateIdentityOpts {
  name: string;
  certPath: string;
  keyPath: string;
}

export async function generateIdentity(
  opts: GenerateIdentityOpts,
): Promise<AgentIdentity> {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";

  // No expiry in v1 — set to 100 years
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + 100,
  );

  const attrs = [{ name: "commonName", value: opts.name }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(opts.certPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.keyPath), { recursive: true });

  fs.writeFileSync(opts.certPath, certPem);
  fs.writeFileSync(opts.keyPath, keyPem, { mode: 0o600 });

  const fingerprint = getFingerprint(certPem);

  return {
    name: opts.name,
    certPath: opts.certPath,
    keyPath: opts.keyPath,
    fingerprint,
  };
}

export function getFingerprint(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return `sha256:${md.digest().toHex()}`;
}
